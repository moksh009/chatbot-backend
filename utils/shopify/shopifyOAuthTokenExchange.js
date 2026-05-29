'use strict';

const axios = require('axios');

/**
 * Exchange Shopify OAuth authorization code for expiring offline access token.
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
 */
async function exchangeShopifyAuthorizationCode(shopHostname, { clientId, clientSecret, code }) {
  const shop = String(shopHostname || '')
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .trim();
  if (!shop || !clientId || !clientSecret || !code) {
    throw new Error('Shopify OAuth token exchange missing shop, clientId, clientSecret, or code');
  }

  const body = new URLSearchParams();
  body.set('client_id', String(clientId).trim());
  body.set('client_secret', String(clientSecret).trim());
  body.set('code', String(code).trim());
  body.set('expiring', '1');

  const res = await axios.post(`https://${shop}/admin/oauth/access_token`, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    timeout: 20000,
  });

  return res.data || {};
}

function shopifyTokenExpiryDate(expiresIn) {
  const sec = Number(expiresIn);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return new Date(Date.now() + sec * 1000);
}

function isNonExpiringTokenRejection(err) {
  const blob = JSON.stringify(err?.response?.data || err?.message || '').toLowerCase();
  return (
    blob.includes('non-expiring access tokens are no longer accepted') ||
    blob.includes('non-expiring access token') ||
    blob.includes('expiring offline tokens')
  );
}

const SHOPIFY_RECONNECT_MESSAGE =
  'Your Shopify token is outdated. Open Settings → Connections, disconnect Shopify, then connect again to refresh access.';

module.exports = {
  exchangeShopifyAuthorizationCode,
  shopifyTokenExpiryDate,
  isNonExpiringTokenRejection,
  SHOPIFY_RECONNECT_MESSAGE,
};
