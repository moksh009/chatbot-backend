'use strict';

const { decrypt } = require('./encryption');
const {
  getEffectiveWhatsAppAccessToken,
  getEffectiveWhatsAppPhoneNumberId,
  getEffectiveWhatsAppWabaId,
  isWhatsAppOutboundReady,
} = require('../meta/clientWhatsAppCreds');
const SHOPIFY_CONNECTION_BYPASS_CLIENTS = new Set(['delitech_smarthomes']);

/**
 * Derive integration connection flags from a Client document (or lean object).
 * Uses the same rules as AuthContext.resolveConfig — no remote calls.
 */
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

function buildConnectionStatusPayload(client) {
  if (!client) {
    return {
      shopify_connected: false,
      whatsapp_connected: false,
      meta_connected: false,
      instagram_connected: false,
    };
  }

  const shopDomain =
    client.shopDomain ||
    client.commerce?.shopify?.domain ||
    client.config?.shopDomain ||
    '';
  const shopifyEnc =
    client.shopifyAccessToken ||
    client.commerce?.shopify?.accessToken ||
    '';
  const shopifyTok = decryptToken(shopifyEnc);
  /** @deprecated inline — prefer isShopifyCredentialConnected */
  const shopifyCredentialPresent =
    (typeof shopifyTok === 'string' && shopifyTok.length > 8) ||
    (typeof shopifyEnc === 'string' && shopifyEnc.trim().length > 12);

  const phoneId = getEffectiveWhatsAppPhoneNumberId(client);
  const waba = getEffectiveWhatsAppWabaId(client);
  const waTok = getEffectiveWhatsAppAccessToken(client);

  const instagramTok =
    client.instagramAccessToken ||
    client.social?.instagram?.accessToken ||
    '';
  const instagramPage =
    client.instagramPageId ||
    client.social?.instagram?.pageId ||
    '';

  const metaAdsOk = !!(
    client.metaAdsConnected ||
    (typeof client.metaAdsToken === 'string' && decryptToken(client.metaAdsToken).length > 10) ||
    client.metaAdAccountId
  );

  const bypassShopifyConnected = SHOPIFY_CONNECTION_BYPASS_CLIENTS.has(
    String(client.clientId || '').trim()
  );
  const { isShopifyCredentialConnected } = require('../shopify/resolveShopifyCredentials');

  return {
    shopify_connected: bypassShopifyConnected
      ? true
      : isShopifyCredentialConnected(client),
    whatsapp_connected: isWhatsAppOutboundReady(client),
    meta_connected: !!metaAdsOk,
    instagram_connected: !!(decryptToken(instagramTok).length > 10 && instagramPage),
  };
}

/**
 * Resolve WhatsApp IDs/tokens from a Client doc (top-level + legacy nested paths).
 */
function resolveWhatsAppFields(client) {
  if (!client) {
    return { phoneNumberId: '', wabaId: '', tokenPlain: '', tokenEnc: '' };
  }
  const phoneNumberId = getEffectiveWhatsAppPhoneNumberId(client);
  const wabaId = getEffectiveWhatsAppWabaId(client);
  const tokenPlain = getEffectiveWhatsAppAccessToken(client);
  const tokenEnc =
    client.whatsappToken ||
    client.whatsapp?.accessToken ||
    client.config?.whatsappToken ||
    '';
  return { phoneNumberId, wabaId, tokenPlain, tokenEnc };
}

function isWhatsAppClientConnected(client) {
  return buildConnectionStatusPayload(client).whatsapp_connected;
}

module.exports = {
  buildConnectionStatusPayload,
  decryptToken,
  isValidShopDomain,
  resolveWhatsAppFields,
  isWhatsAppClientConnected,
};
