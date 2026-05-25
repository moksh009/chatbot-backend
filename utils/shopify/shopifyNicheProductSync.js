'use strict';

const Client = require('../../models/Client');
const { withShopifyRetry } = require('./shopifyHelper');
const { invalidateClientCache } = require('../core/clientCache');
const log = require('../core/logger')('ShopifyNicheSync');

/**
 * Paginated Shopify Admin products fetch (active catalog).
 */
async function fetchAllShopifyProducts(shop) {
  const all = [];
  let sinceId = null;

  for (let page = 0; page < 40; page += 1) {
    let path = '/products.json?limit=250&status=active';
    if (sinceId) path += `&since_id=${sinceId}`;
    const res = await shop.get(path);
    const batch = Array.isArray(res.data?.products) ? res.data.products : [];
    if (!batch.length) break;

    all.push(...batch);
    sinceId = batch[batch.length - 1]?.id;
    if (!sinceId || batch.length < 250) break;
  }

  return all;
}

function normalizeShopDomain(shopDomain) {
  return String(shopDomain || '')
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .trim();
}

/**
 * Maps a Shopify product into nicheData.products shape (WhatsApp / bot catalog hints).
 */
function mapProductForNiche(product, shopDomain) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const firstVariant = variants.find((v) => v != null) || null;
  const handle = product?.handle || String(product?.id || '');
  const domain = normalizeShopDomain(shopDomain);

  return {
    id: product?.id,
    title: String(product?.title || 'Untitled').trim() || 'Untitled',
    handle,
    price: firstVariant?.price != null ? String(firstVariant.price) : '0',
    image: product?.image?.src || product?.images?.[0]?.src || null,
    url: domain && handle ? `https://${domain}/products/${handle}` : null,
  };
}

/**
 * Sync Shopify products into Client.nicheData.products (used by shopify-hub "in bot" flags).
 */
async function syncNicheDataProducts(clientId) {
  if (!clientId) throw new Error('clientId is required');

  const client = await Client.findOne({ clientId }).select(
    'shopDomain shopifyAccessToken shopifyConnectionStatus'
  );
  if (!client) throw new Error('Client not found');
  if (!client.shopDomain || !client.shopifyAccessToken) {
    throw new Error('Shopify not connected');
  }

  const mapped = await withShopifyRetry(clientId, async (shop) => {
    const raw = await fetchAllShopifyProducts(shop);
    return raw.map((p) => mapProductForNiche(p, client.shopDomain));
  });

  await Client.updateOne(
    { clientId },
    {
      $set: {
        'nicheData.products': mapped,
        shopifyLastProductSync: new Date(),
        shopifyProductCount: mapped.length,
        shopifySyncLastError: '',
      },
    }
  );

  try {
    const { clearClientCache } = require('../../middleware/apiCache');
    await clearClientCache(clientId);
  } catch (cacheErr) {
    log.warn(`clearClientCache skipped for ${clientId}: ${cacheErr.message}`);
  }
  invalidateClientCache(clientId);

  return { count: mapped.length, products: mapped };
}

module.exports = {
  fetchAllShopifyProducts,
  mapProductForNiche,
  syncNicheDataProducts,
};
