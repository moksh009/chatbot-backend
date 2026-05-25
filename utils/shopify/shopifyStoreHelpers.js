'use strict';

/**
 * Multi-store MVP helpers (Phase 8). Backward compatible with single shopDomain.
 */
function normalizeShopDomain(domain) {
  if (!domain) return '';
  return String(domain).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

function getPrimaryStore(client) {
  const stores = client?.shopifyStores || [];
  if (stores.length) {
    const primary = stores.find((s) => s.isPrimary) || stores[0];
    return primary;
  }
  if (client?.shopDomain) {
    return {
      shopDomain: client.shopDomain,
      accessToken: client.shopifyAccessToken,
      isPrimary: true,
      label: 'Primary store',
      status: client.shopifyConnectionStatus || 'connected',
      connectedAt: client.updatedAt,
    };
  }
  return null;
}

function syncLegacyShopifyFields(client) {
  const primary = getPrimaryStore(client);
  if (!primary) return client;
  client.shopDomain = primary.shopDomain || client.shopDomain;
  if (primary.accessToken) client.shopifyAccessToken = primary.accessToken;
  return client;
}

function findClientByShopDomain(clients, shop) {
  const norm = normalizeShopDomain(shop);
  for (const c of clients) {
    const stores = c.shopifyStores || [];
    if (stores.some((s) => normalizeShopDomain(s.shopDomain) === norm)) return { client: c, store: stores.find((s) => normalizeShopDomain(s.shopDomain) === norm) };
    if (normalizeShopDomain(c.shopDomain) === norm) return { client: c, store: getPrimaryStore(c) };
  }
  return null;
}

async function resolveClientForShop(shop) {
  const Client = require('../../models/Client');
  const norm = normalizeShopDomain(shop);
  let client = await Client.findOne({
    $or: [{ shopDomain: norm }, { 'shopifyStores.shopDomain': norm }],
  }).lean();
  if (!client) return null;
  const store =
    (client.shopifyStores || []).find((s) => normalizeShopDomain(s.shopDomain) === norm) ||
    getPrimaryStore(client);
  return { client, store };
}

function ensureStoresFromLegacy(clientDoc) {
  if (!clientDoc.shopifyStores?.length && clientDoc.shopDomain) {
    clientDoc.shopifyStores = [
      {
        shopDomain: clientDoc.shopDomain,
        accessToken: clientDoc.shopifyAccessToken,
        scopes: clientDoc.shopifyScopes,
        connectedAt: clientDoc.updatedAt || new Date(),
        isPrimary: true,
        label: 'Primary store',
        status: clientDoc.shopifyConnectionStatus || 'connected',
      },
    ];
  }
  return clientDoc;
}

module.exports = {
  normalizeShopDomain,
  getPrimaryStore,
  syncLegacyShopifyFields,
  resolveClientForShop,
  ensureStoresFromLegacy,
};
