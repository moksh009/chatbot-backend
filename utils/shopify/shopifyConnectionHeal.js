'use strict';

const axios = require('axios');
const Client = require('../../models/Client');
const { decrypt } = require('../core/encryption');
const { invalidateClientCache } = require('../core/clientCache');
const shopifyAdminApiVersion = require('./shopifyAdminApiVersion');
const { resolveShopifyCredentials } = require('./resolveShopifyCredentials');
const { shopifyTokenExpiryDate } = require('./shopifyOAuthTokenExchange');

const REFRESH_WINDOW_MS = 30 * 60 * 1000; // refresh 30 min before expiry

function decryptField(val) {
  if (!val || typeof val !== 'string') return '';
  try {
    return decrypt(val);
  } catch (_) {
    return val;
  }
}

function shopifyAppCredentials(client) {
  const clientId =
    decryptField(client?.shopifyClientId) ||
    process.env.SHOPIFY_CLIENT_ID ||
    process.env.SHOPIFY_API_KEY ||
    '';
  const clientSecret =
    decryptField(client?.shopifyClientSecret) ||
    process.env.SHOPIFY_CLIENT_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    '';
  return { clientId: String(clientId).trim(), clientSecret: String(clientSecret).trim() };
}

/**
 * Live probe — does the stored access token work right now?
 */
async function probeShopifyAccess(client) {
  const creds = resolveShopifyCredentials(client);
  const token = creds.tokenPlain;
  const domain = creds.shopDomain;
  if (!token || token.length < 8 || !domain) {
    return { ok: false, tokenStatus: 'missing', domain: domain || null };
  }
  try {
    const res = await axios.get(
      `https://${domain}/admin/api/${shopifyAdminApiVersion}/shop.json`,
      {
        headers: { 'X-Shopify-Access-Token': token },
        timeout: 8000,
        validateStatus: () => true,
      }
    );
    if (res.status === 200) return { ok: true, tokenStatus: 'valid', domain };
    if (res.status === 401) return { ok: false, tokenStatus: 'revoked', domain };
    if (res.status === 403) return { ok: false, tokenStatus: 'scope_insufficient', domain };
    return { ok: true, tokenStatus: 'valid', domain };
  } catch (err) {
    const transient =
      err.code === 'ENOTFOUND' ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNABORTED';
    return { ok: transient, tokenStatus: transient ? 'valid' : 'unknown', domain };
  }
}

/**
 * Exchange refresh token for a new access token (Shopify expiring offline tokens, 2026).
 */
async function refreshShopifyAccessToken(clientId, { force = false } = {}) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) return { ok: false, reason: 'client_not_found' };

  const creds = resolveShopifyCredentials(client);
  const refreshRaw = decryptField(client.shopifyRefreshToken || client.commerce?.shopify?.refreshToken);
  if (!refreshRaw) return { ok: false, reason: 'no_refresh_token' };

  const { clientId: appId, clientSecret } = shopifyAppCredentials(client);
  if (!appId || !clientSecret) return { ok: false, reason: 'missing_app_credentials' };

  const domain = creds.shopDomain;
  if (!domain) return { ok: false, reason: 'missing_domain' };

  const expiresAtMs = client.shopifyTokenExpiresAt
    ? new Date(client.shopifyTokenExpiresAt).getTime()
    : null;
  const needsRefresh =
    force ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs - Date.now() < REFRESH_WINDOW_MS;

  if (!needsRefresh) return { ok: true, reason: 'not_due', skipped: true };

  try {
    const body = new URLSearchParams();
    body.set('client_id', appId);
    body.set('client_secret', clientSecret);
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', refreshRaw);

    const res = await axios.post(`https://${domain}/admin/oauth/access_token`, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      timeout: 20000,
    });

    const { access_token, refresh_token, expires_in, scope } = res.data || {};
    if (!access_token) return { ok: false, reason: 'no_access_token_in_response' };

    const stores = [...(client.shopifyStores || [])];
    const norm = domain.toLowerCase();
    let touched = false;
    for (let i = 0; i < stores.length; i++) {
      const sd = String(stores[i]?.shopDomain || '').toLowerCase();
      if (sd === norm || sd.includes(norm.split('.')[0])) {
        stores[i] = {
          ...stores[i],
          accessToken: access_token,
          scopes: scope || stores[i].scopes,
          status: 'connected',
        };
        touched = true;
      }
    }

    const update = {
      shopifyAccessToken: access_token,
      'commerce.shopify.accessToken': access_token,
      shopifyRefreshToken: refresh_token || client.shopifyRefreshToken,
      'commerce.shopify.refreshToken': refresh_token || client.commerce?.shopify?.refreshToken || '',
      shopifyTokenExpiresAt: shopifyTokenExpiryDate(expires_in),
      shopifyConnectionStatus: 'connected',
      lastShopifyError: '',
      shopifyScopes: scope || client.shopifyScopes || '',
    };
    if (touched) update.shopifyStores = stores;

    await Client.updateOne({ clientId }, { $set: update });
    invalidateClientCache(clientId);

    try {
      const { writeProbeCache } = require('../security/connectionTokenProbe');
      await writeProbeCache(clientId, 'shopify', {
        tokenStatus: 'valid',
        ok: true,
        at: new Date().toISOString(),
      });
    } catch (_) {}

    console.log(`✅ [ShopifyHeal] Token refreshed for ${clientId} (${domain})`);
    return { ok: true, reason: 'refreshed' };
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.warn(`[ShopifyHeal] Refresh failed for ${clientId}:`, JSON.stringify(detail));
    return { ok: false, reason: 'refresh_failed', detail };
  }
}

/**
 * Reconcile DB status with live Shopify API — heals false "error" / "expired" states.
 */
async function reconcileShopifyConnection(clientId, { tryRefresh = true } = {}) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) return { connected: false, healed: false };

  const creds = resolveShopifyCredentials(client);
  if (!creds.shopDomain || !creds.tokenPlain) {
    return { connected: false, healed: false, reason: 'missing_credentials' };
  }

  const status = String(client.shopifyConnectionStatus || '').toLowerCase();
  if (status === 'disconnected') {
    return { connected: false, healed: false, reason: 'disconnected' };
  }

  let probe = await probeShopifyAccess(client);

  if (!probe.ok && tryRefresh) {
    const refreshResult = await refreshShopifyAccessToken(clientId, { force: status === 'error' });
    if (refreshResult.ok && !refreshResult.skipped) {
      const refreshed = await Client.findOne({ clientId }).lean();
      probe = await probeShopifyAccess(refreshed);
    }
  }

  if (probe.ok) {
    if (status === 'error' || client.lastShopifyError) {
      await Client.updateOne(
        { clientId },
        { $set: { shopifyConnectionStatus: 'connected', lastShopifyError: '' } }
      );
      invalidateClientCache(clientId);
      return { connected: true, healed: status === 'error', reason: 'probe_valid' };
    }
    return { connected: true, healed: false, reason: 'already_connected' };
  }

  if (probe.tokenStatus === 'revoked') {
    if (status !== 'error') {
      await Client.updateOne(
        { clientId },
        {
          $set: {
            shopifyConnectionStatus: 'error',
            lastShopifyError: 'Shopify access revoked — reinstall the TopEdge app on your store.',
          },
        }
      );
      invalidateClientCache(clientId);
    }
    return { connected: false, healed: false, reason: 'revoked' };
  }

  return { connected: status !== 'error' && status !== 'disconnected', healed: false, reason: probe.tokenStatus };
}

module.exports = {
  probeShopifyAccess,
  refreshShopifyAccessToken,
  reconcileShopifyConnection,
  shopifyAppCredentials,
  REFRESH_WINDOW_MS,
};
