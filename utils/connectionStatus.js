'use strict';

const { decrypt } = require('./encryption');

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

  const phoneId =
    client.phoneNumberId ||
    client.whatsapp?.phoneNumberId ||
    client.config?.phoneNumberId ||
    '';
  const waba =
    client.wabaId ||
    client.whatsapp?.wabaId ||
    client.config?.wabaId ||
    '';
  const waEnc =
    client.whatsappToken ||
    client.whatsapp?.accessToken ||
    '';
  const waTok = decryptToken(waEnc);

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

  return {
    shopify_connected: !!(shopifyTok.length > 8 && isValidShopDomain(shopDomain)),
    whatsapp_connected: !!(waTok.length > 5 && phoneId && waba),
    meta_connected: !!metaAdsOk,
    instagram_connected: !!(decryptToken(instagramTok).length > 10 && instagramPage),
  };
}

module.exports = {
  buildConnectionStatusPayload,
  decryptToken,
  isValidShopDomain,
};
