'use strict';

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

module.exports = { buildRecoveryUrl };
