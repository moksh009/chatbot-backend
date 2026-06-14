'use strict';

/**
 * Per-lead recovery URL builder + UTM tagging for WhatsApp cart recovery.
 * BUG-017: pre-filled /cart/recover/{token} instead of generic store URL.
 */

function normalizeStoreHost(client = {}) {
  const raw = client.shopDomain || client.shopifyDomain || '';
  return String(raw).replace(/^https?:\/\//, '').split('/')[0];
}

function buildLeadRecoveryBaseUrl(client, lead = {}) {
  const snap = lead.cartSnapshot || {};
  const storeHost = normalizeStoreHost(client);
  const token = lead.checkoutToken || snap.checkoutToken || lead.cartToken || '';
  if (storeHost && token) {
    return `https://${storeHost}/cart/recover/${encodeURIComponent(String(token))}`;
  }
  return (
    lead.recoveryUrl ||
    lead.checkoutUrl ||
    snap.checkoutUrl ||
    lead.cartUrl ||
    lead.abandoned_checkout_url ||
    ''
  );
}

/**
 * Append UTM params to cart recovery links for GA4 / Shopify attribution.
 */
function buildRecoveryUrl(baseUrl, step = 1) {
  if (!baseUrl || typeof baseUrl !== 'string') return baseUrl || '';
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('utm_source', 'whatsapp');
    url.searchParams.set('utm_medium', 'cart_recovery');
    url.searchParams.set('utm_campaign', `cart_msg_${step}`);
    return url.toString();
  } catch {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}utm_source=whatsapp&utm_medium=cart_recovery&utm_campaign=cart_msg_${step}`;
  }
}

function buildLeadRecoveryUrl(client, lead = {}, step = 1) {
  const base = buildLeadRecoveryBaseUrl(client, lead);
  return buildRecoveryUrl(base, step);
}

module.exports = {
  normalizeStoreHost,
  buildLeadRecoveryBaseUrl,
  buildLeadRecoveryUrl,
  buildRecoveryUrl,
};
