'use strict';

const Client = require('../../models/Client');
const { getAppRedis } = require('../core/redisFactory');
const log = require('../core/logger')('LiveProductLookup');

const STOCK_PATTERNS =
  /\b(in stock|available|do you have|have you got|kitna|price|cost|how much)\b/i;

function detectProductIntent(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  const inventory = /\b(stock|available|in stock|do you have|have you got|milega)\b/i.test(t);
  const price = /\b(price|cost|how much|kitna|rate|mrp)\b/i.test(t);
  if (!inventory && !price) return null;
  const words = t.replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const hint = words.slice(-4).join(' ');
  return { type: inventory ? 'inventory_check' : 'price_check', productHint: hint || t.slice(0, 40) };
}

function matchCatalogProduct(client, hint) {
  const products = client?.nicheData?.products || client?.products || [];
  const h = String(hint || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const p of products) {
    const title = String(p.title || p.name || '').toLowerCase();
    const score = title.includes(h) ? h.length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best || products[0] || null;
}

async function fetchLiveSku(clientId, sku, client, storeKey = '') {
  const redis = getAppRedis();
  const key = `sku_live:${clientId}:${storeKey || 'all'}:${sku}`;
  if (redis) {
    const hit = await redis.get(key);
    if (hit) return { ...JSON.parse(hit), freshness: 'cached' };
  }
  const start = Date.now();
  try {
    let shopDomain = client.shopDomain || client.commerce?.shopify?.domain;
    let token = client.shopifyAccessToken || client.commerce?.shopify?.accessToken;
    if (storeKey && client.shopifyStores?.length) {
      const { normalizeShopDomain, getPrimaryStore } = require('../shopify/shopifyStoreHelpers');
      const norm = normalizeShopDomain(storeKey);
      const store =
        client.shopifyStores.find((s) => normalizeShopDomain(s.shopDomain) === norm) || getPrimaryStore(client);
      if (store) {
        shopDomain = store.shopDomain;
        token = store.accessToken || token;
      }
    }
    if (!shopDomain || !token) throw new Error('shopify_not_connected');
    const axios = require('axios');
    const shopifyAdminApiVersion = require('../shopify/shopifyAdminApiVersion');
    const res = await axios.get(
      `https://${shopDomain}/admin/api/${shopifyAdminApiVersion}/products.json?limit=1&fields=id,title,variants`,
      {
        headers: { 'X-Shopify-Access-Token': token },
        timeout: 500,
      }
    );
    const variant = res.data?.products?.[0]?.variants?.find((v) => String(v.sku) === String(sku)) ||
      res.data?.products?.[0]?.variants?.[0];
    const payload = {
      inStock: (variant?.inventory_quantity ?? 0) > 0,
      price: variant?.price,
      title: res.data?.products?.[0]?.title,
      sku,
      ms: Date.now() - start,
    };
    if (redis) await redis.set(key, JSON.stringify(payload), 'EX', 300);
    return { ...payload, freshness: 'live' };
  } catch (e) {
    log.warn(`live sku failed: ${e.message}`);
    const cached = matchCatalogProduct(client, sku);
    return {
      inStock: cached?.inStock !== false,
      price: cached?.price,
      title: cached?.title || cached?.name,
      sku,
      freshness: 'stale',
    };
  }
}

async function lookupProduct(clientId, productHint, options = {}) {
  const client = await Client.findOne({ clientId }).lean();
  const product = matchCatalogProduct(client, productHint);
  if (!product) return { found: false };
  const sku = product.sku || product.variantSku || product.id;
  const storeKey = options.storeKey || '';
  const live = await fetchLiveSku(clientId, sku, client, storeKey);
  let storeLabel = '';
  if (storeKey && client.shopifyStores?.length) {
    const { normalizeShopDomain } = require('../shopify/shopifyStoreHelpers');
    const store = client.shopifyStores.find(
      (s) => normalizeShopDomain(s.shopDomain) === normalizeShopDomain(storeKey)
    );
    storeLabel = store?.label || storeKey;
  }
  return { found: true, product, live, storeLabel };
}

module.exports = { detectProductIntent, lookupProduct, STOCK_PATTERNS };
