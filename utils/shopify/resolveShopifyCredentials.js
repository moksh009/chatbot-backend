'use strict';

const { decrypt } = require('../core/encryption');
const {
  getPrimaryStore,
  normalizeShopDomain,
  ensureStoresFromLegacy,
  syncLegacyShopifyFields,
} = require('./shopifyStoreHelpers');

function decryptToken(enc) {
  if (!enc || typeof enc !== 'string') return '';
  try {
    const plain = decrypt(enc);
    return typeof plain === 'string' ? plain.trim() : '';
  } catch (_) {
    return '';
  }
}

function isValidShopDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const d = domain.trim().toLowerCase();
  if (!d.includes('.') || d.includes('your-store')) return false;
  return true;
}

/**
 * Resolve Shopify domain + token from Client (legacy fields + shopifyStores[]).
 */
function resolveShopifyCredentials(client) {
  if (!client) {
    return { shopDomain: '', tokenEnc: '', tokenPlain: '', scopes: '', primary: null };
  }

  const doc = { ...client };
  if (doc.shopifyStores?.length) {
    syncLegacyShopifyFields(doc);
  } else {
    ensureStoresFromLegacy(doc);
    syncLegacyShopifyFields(doc);
  }

  const primary = getPrimaryStore(doc);
  const shopDomain = normalizeShopDomain(
    primary?.shopDomain ||
      doc.shopDomain ||
      doc.commerce?.shopify?.domain ||
      doc.config?.shopDomain ||
      ''
  );

  const tokenEnc =
    primary?.accessToken ||
    doc.shopifyAccessToken ||
    doc.commerce?.shopify?.accessToken ||
    doc.config?.shopifyAccessToken ||
    '';

  const tokenPlain = decryptToken(tokenEnc);
  const scopes = primary?.scopes || doc.shopifyScopes || '';

  return { shopDomain, tokenEnc, tokenPlain, scopes, primary };
}

function isShopifyCredentialConnected(client) {
  const { shopDomain, tokenPlain, tokenEnc } = resolveShopifyCredentials(client);
  if (!isValidShopDomain(shopDomain)) return false;
  const connStatus = String(client?.shopifyConnectionStatus || '').toLowerCase();
  if (connStatus === 'disconnected' || connStatus === 'error') return false;
  return (
    (typeof tokenPlain === 'string' && tokenPlain.length > 8) ||
    (typeof tokenEnc === 'string' && tokenEnc.trim().length > 20)
  );
}

/**
 * If token exists on primary store but legacy top-level fields are empty, persist mirror fields.
 */
async function repairLegacyShopifyFields(clientId) {
  const Client = require('../../models/Client');
  const { invalidateClientCache } = require('../core/clientCache');

  const client = await Client.findOne({ clientId });
  if (!client) return false;

  ensureStoresFromLegacy(client);
  syncLegacyShopifyFields(client);

  const primary = getPrimaryStore(client);
  if (!primary?.shopDomain || !primary?.accessToken) return false;

  const legacyTok = client.shopifyAccessToken;
  if (legacyTok && String(legacyTok).trim().length > 8) return true;

  await Client.updateOne(
    { clientId },
    {
      $set: {
        shopDomain: primary.shopDomain,
        shopifyAccessToken: primary.accessToken,
        shopifyScopes: primary.scopes || client.shopifyScopes || '',
        shopifyConnectionStatus: primary.status || 'connected',
        'commerce.shopify.domain': primary.shopDomain,
        'commerce.shopify.accessToken': primary.accessToken,
        'commerce.storeType': 'shopify',
        storeType: 'shopify',
      },
    }
  );
  invalidateClientCache(clientId);
  return true;
}

module.exports = {
  resolveShopifyCredentials,
  isShopifyCredentialConnected,
  repairLegacyShopifyFields,
};
