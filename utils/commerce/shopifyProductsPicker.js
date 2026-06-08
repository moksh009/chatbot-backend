'use strict';

const Client = require('../../models/Client');
const { withShopifyRetry } = require('../shopify/shopifyHelper');
const { resolveShopifyCredentials } = require('../shopify/resolveShopifyCredentials');

function mapProduct(p) {
  const variant = p.variants?.[0];
  return {
    id: String(p.id),
    shopifyId: String(p.id),
    title: p.title,
    handle: p.handle,
    imageUrl: p.images?.[0]?.src || '',
    price: variant?.price || '',
    sku: variant?.sku || '',
    variantId: variant?.id ? String(variant.id) : '',
  };
}

async function listShopifyProductsForPicker(clientId, { q = '', limit = 50 } = {}) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) return { success: false, products: [], message: 'Client not found' };

  const creds = resolveShopifyCredentials(client);
  if (!creds.shopDomain || !creds.tokenPlain) {
    return { success: false, products: [], message: 'Shopify not connected' };
  }

  const search = String(q || '').trim().toLowerCase();
  const max = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const products = await withShopifyRetry(clientId, async (shop) => {
    const resp = await shop.get(
      `/products.json?limit=250&fields=id,title,handle,variants,images,status`
    );
    return (resp.data.products || [])
      .filter((p) => p.status === 'active' || !p.status)
      .map(mapProduct);
  });

  const filtered = search
    ? products.filter(
        (p) =>
          p.title.toLowerCase().includes(search) ||
          String(p.sku || '').toLowerCase().includes(search) ||
          String(p.handle || '').toLowerCase().includes(search)
      )
    : products;

  return { success: true, products: filtered.slice(0, max) };
}

/** Alias used by dynamicClientRouter */
async function fetchShopifyProductsForClient(clientId, { query = '', limit = 50 } = {}) {
  return listShopifyProductsForPicker(clientId, { q: query, limit });
}

module.exports = {
  listShopifyProductsForPicker,
  fetchShopifyProductsForClient,
  mapProduct,
};
