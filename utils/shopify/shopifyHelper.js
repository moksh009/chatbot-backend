const axios = require('axios');
const Client = require('../../models/Client');
const { encrypt, decrypt } = require('../core/encryption');
const shopifyAdminApiVersion = require('./shopifyAdminApiVersion');
const { shopifyBreaker } = require('../core/circuitBreaker');
const { createTimer } = require('../core/perfLogger');
const { getCachedClient, invalidateClientCache } = require('../core/clientCache');
const {
  resolveShopifyCredentials,
  repairLegacyShopifyFields,
} = require('./resolveShopifyCredentials');

const SHOPIFY_CLIENT_SELECT =
  'shopDomain shopifyAccessToken shopifyRefreshToken shopifyClientId shopifyClientSecret shopifyApiVersion shopifyTokenExpiresAt commerce shopifyConnectionStatus lastShopifyError shopifyStores shopifyScopes';

/**
 * Robust Shopify Client Generator with Auto-Refresh & Self-Healing
 * Standardizes API communication and handles OAuth token rotation automatically.
 */
async function getShopifyClient(clientId, forceRefresh = false) {
    const timer = createTimer('Shopify.getShopifyClient', clientId);
    timer.checkpoint('START', { forceRefresh });
    let client = await timer.time('getCachedClient', () =>
      getCachedClient(clientId, SHOPIFY_CLIENT_SELECT)
    );
    if (!client) throw new Error('Client not found');

    let creds = resolveShopifyCredentials(client);
    if (!creds.tokenPlain && creds.shopDomain) {
      await repairLegacyShopifyFields(clientId);
      invalidateClientCache(clientId);
      client = await getCachedClient(clientId, SHOPIFY_CLIENT_SELECT);
      creds = resolveShopifyCredentials(client);
    }

    let token = creds.tokenPlain;
    const domain = creds.shopDomain;
    const apiVersion = client.shopifyApiVersion || shopifyAdminApiVersion;

    // STRICT VALIDATION: Prevent OAuth requests to invalid domains which cause HTML crashes
    if (!domain || domain.includes('your-store') || !domain.includes('.')) {
        console.error(`❌ [ShopifyClient] Invalid or missing domain for ${clientId}: ${domain}`);
        throw new Error('Shopify credentials incomplete or invalid domain configuration');
    }

    // 1. Proactive refresh for expiring offline tokens (Shopify embedded app / OAuth 2026).
    // Only rotate when a refresh token exists — never mark "error" solely because expiry date passed.
    const { refreshShopifyAccessToken, probeShopifyAccess } = require('./shopifyConnectionHeal');
    const fiveMinutes = 5 * 60 * 1000;
    const expiresAtMs = client.shopifyTokenExpiresAt
      ? new Date(client.shopifyTokenExpiresAt).getTime()
      : null;
    const isNextToExpiry =
      Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() < fiveMinutes;
    const hasRefreshToken = !!(
      client.shopifyRefreshToken && String(client.shopifyRefreshToken).trim()
    );
    const shouldAttemptRefresh =
      forceRefresh || (isNextToExpiry && hasRefreshToken) || (forceRefresh && hasRefreshToken);

    if (shouldAttemptRefresh) {
      console.log(
        `[ShopifyRotation] ${forceRefresh ? 'FORCED' : 'Auto'} refresh for ${clientId}...`
      );
      const refreshResult = await refreshShopifyAccessToken(clientId, { force: forceRefresh });
      if (refreshResult.ok && !refreshResult.skipped) {
        invalidateClientCache(clientId);
        client = await getCachedClient(clientId, SHOPIFY_CLIENT_SELECT);
        creds = resolveShopifyCredentials(client);
        token = creds.tokenPlain;
      } else if (forceRefresh && !refreshResult.ok) {
        const probe = await probeShopifyAccess(client);
        if (!probe.ok) {
          const errorMsg = `Shopify refresh failed: ${refreshResult.reason || 'unknown'}`;
          await Client.updateOne(
            { clientId },
            { $set: { shopifyConnectionStatus: 'error', lastShopifyError: errorMsg } }
          );
          invalidateClientCache(clientId);
          throw new Error(errorMsg);
        }
        console.warn(
          `[ShopifyRotation] Refresh failed for ${clientId} but existing token still valid — continuing`
        );
      }
    }

    if (!token || !domain) {
        console.error(`❌ [ShopifyClient] Missing credentials for ${clientId}. Token: ${!!token}, Domain: ${domain}`);
        throw new Error('Shopify credentials incomplete or invalid');
    }

    const https = require('https');
    const instance = axios.create({
        baseURL: `https://${domain}/admin/api/${apiVersion}`,
        timeout: 12000,
        httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 20 }),
        headers: { 
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
        }
    });

    instance.interceptors.response.use(
        response => response,
        async (error) => {
            if (error.response?.status === 401) {
                console.warn(`[ShopifyAuth] 401 for ${clientId} — attempting heal before flagging error`);
                const { reconcileShopifyConnection } = require('./shopifyConnectionHeal');
                const healed = await reconcileShopifyConnection(clientId, { tryRefresh: true });
                if (!healed.connected) {
                    await Client.updateOne(
                        { clientId },
                        {
                          $set: {
                            shopifyConnectionStatus: 'error',
                            lastShopifyError:
                              'Shopify access revoked — open Settings → Connections and reconnect your store.',
                          },
                        }
                    );
                    invalidateClientCache(clientId);
                }
            }
            return Promise.reject(error);
        }
    );

    timer.finish('client_ready');
    return instance;
}

/**
 * SELF-HEALING WRAPPER
 * Automatically detects 401s, rotates tokens, and retries the request up to 3 times.
 */
function isShopifyScopeOrPermissionError(err) {
  const data = err?.response?.data;
  const blob = JSON.stringify(data || err?.message || '').toLowerCase();
  return (
    blob.includes('scope') ||
    blob.includes('access denied') ||
    blob.includes('merchant approval') ||
    blob.includes('not approved') ||
    blob.includes('required access') ||
    blob.includes('read_locations') ||
    blob.includes('read_inventory')
  );
}

function throwShopifyReconnectIfLegacyToken(err) {
  const { isNonExpiringTokenRejection, SHOPIFY_RECONNECT_MESSAGE } = require('./shopifyOAuthTokenExchange');
  if (isNonExpiringTokenRejection(err)) {
    const reconnectErr = new Error(SHOPIFY_RECONNECT_MESSAGE);
    reconnectErr.code = 'SHOPIFY_TOKEN_LEGACY';
    reconnectErr.isShopifyAuthError = true;
    throw reconnectErr;
  }
}

async function flagShopifyReconnectRequired(clientId, message) {
  await Client.updateOne(
    { clientId },
    {
      $set: {
        shopifyConnectionStatus: 'error',
        lastShopifyError: message,
      },
    }
  );
  invalidateClientCache(clientId);
  // Also bust the workspace connection-status Redis cache so UI sees error immediately
  try {
    const { invalidateWorkspaceConnectionCache } = require('../core/workspaceConnectionCache');
    await invalidateWorkspaceConnectionCache(clientId);
  } catch (_) {}
}

async function withShopifyRetry(clientId, operation, retryCount = 0) {
    return shopifyBreaker.call(async () => {
    const timer = createTimer('Shopify.withShopifyRetry', `${clientId} attempt=${retryCount}`);
    try {
        const shop = await timer.time('getShopifyClient', () => getShopifyClient(clientId));
        const result = await timer.time('shopify_operation', () => operation(shop));
        timer.finish('success');
        return result;
    } catch (err) {
        const { isNonExpiringTokenRejection, SHOPIFY_RECONNECT_MESSAGE } = require('./shopifyOAuthTokenExchange');
        if (isNonExpiringTokenRejection(err)) {
            await flagShopifyReconnectRequired(clientId, SHOPIFY_RECONNECT_MESSAGE);
            timer.finish('legacy_token');
            const reconnectErr = new Error(SHOPIFY_RECONNECT_MESSAGE);
            reconnectErr.isShopifyAuthError = true;
            throw reconnectErr;
        }

        const isAuthError = err.response?.status === 401;
        const isForbidden = err.response?.status === 403;

        const scopeOrPermission403 = isForbidden && isShopifyScopeOrPermissionError(err);
        if (scopeOrPermission403) {
            timer.finish(`scope_403: ${err.message}`);
            throw err;
        }

        if ((isAuthError || isForbidden) && retryCount < 2) {
            const clientRecord = await getCachedClient(
              clientId,
              'shopifyRefreshToken shopifyClientId'
            );
            const cannotAutoRotate =
                clientRecord?.shopifyClientId && !clientRecord?.shopifyRefreshToken;
            if (cannotAutoRotate) {
                if (isNonExpiringTokenRejection(err)) {
                    await flagShopifyReconnectRequired(clientId, SHOPIFY_RECONNECT_MESSAGE);
                    timer.finish('legacy_token');
                    const reconnectErr = new Error(SHOPIFY_RECONNECT_MESSAGE);
                    reconnectErr.isShopifyAuthError = true;
                    throw reconnectErr;
                }
                const reason = isAuthError ? '401 Unauthorized' : '403 Forbidden';
                const reconnectMsg =
                  'Shopify access expired or was revoked. Disconnect and reconnect your store under Settings → Connections.';
                await flagShopifyReconnectRequired(clientId, reconnectMsg);
                console.warn(
                    `[SelfHealing] ${reason} for ${clientId}: skipped token rotation (no refresh token). Reconnect Shopify under Settings → Connections.`
                );
                const reconnectErr = new Error(reconnectMsg);
                reconnectErr.isShopifyAuthError = true;
                throw reconnectErr;
            }

            const reason = isAuthError ? '401 Unauthorized' : '403 Forbidden';
            console.warn(`[SelfHealing] ${reason} detected for ${clientId}. Attempt ${retryCount + 1}/2...`);
            
            try {
                // For 403, we definitely want a force refresh as scopes might have changed
                await getShopifyClient(clientId, true); 
                console.log(`[SelfHealing] Rotation successful for ${clientId}. Retrying operation...`);
                return await withShopifyRetry(clientId, operation, retryCount + 1);
            } catch (retryErr) {
                console.error(`[SelfHealing] Rotation retry failed for ${clientId}:`, retryErr.message);
                throw retryErr;
            }
        }

        if (retryCount >= 2) {
            console.error(`[SelfHealing] MAX RETRIES reached for ${clientId}. Flagging for manual review.`);
            const errorMsg = isForbidden ? 'Access Denied (403): Check App Scopes' : 'Max Retry Failure';
            await Client.updateOne({ clientId }, { $set: { shopifyConnectionStatus: 'error', lastShopifyError: errorMsg } });
        }
        timer.finish(`error: ${err.message}`);
        throw err;
    }
    });
}

/**
 * Handle initial OAuth exchange and setup
 */
async function exchangeShopifyToken(clientId, shopDomain, shopifyClientId, shopifyClientSecret, code) {
    const cleanDomain = shopDomain.replace('https://', '').replace('http://', '').split('/')[0];
    const {
      exchangeShopifyAuthorizationCode,
      shopifyTokenExpiryDate,
    } = require('./shopifyOAuthTokenExchange');

    const tokenData = code
      ? await exchangeShopifyAuthorizationCode(cleanDomain, {
          clientId: shopifyClientId,
          clientSecret: decrypt(shopifyClientSecret),
          code,
        })
      : (
          await axios.post(`https://${cleanDomain}/admin/oauth/access_token`, {
            client_id: shopifyClientId,
            client_secret: decrypt(shopifyClientSecret),
            grant_type: 'client_credentials',
          })
        ).data;

    const { access_token, refresh_token, expires_in, scope } = tokenData;

    const update = {
        shopifyAccessToken: access_token,
        'commerce.shopify.accessToken': access_token,
        shopifyRefreshToken: refresh_token || "",
        'commerce.shopify.refreshToken': refresh_token || "",
        shopifyScopes: scope || "",
        shopifyClientId,
        'commerce.shopify.clientId': shopifyClientId,
        shopifyClientSecret: shopifyClientSecret,
        'commerce.shopify.clientSecret': shopifyClientSecret,
        shopDomain: cleanDomain,
        'commerce.shopify.domain': cleanDomain,
        shopifyConnectionStatus: 'connected',
        lastShopifyError: ''
    };

    update.shopifyTokenExpiresAt = shopifyTokenExpiryDate(expires_in);

    const updated = await Client.findOneAndUpdate({ clientId }, { $set: update }, { new: true });
    invalidateClientCache(clientId);
    return updated;
}

async function refreshShopifyToken(client) {
  try {
    const { refreshShopifyAccessToken, reconcileShopifyConnection } = require('./shopifyConnectionHeal');
    const clientId = client?.clientId;
    if (!clientId) return { success: false, error: 'missing_client_id' };
    console.log(`[ShopifyRotation] Proactively refreshing token for ${clientId}...`);
    const refreshResult = await refreshShopifyAccessToken(clientId, { force: true });
    if (refreshResult.ok) {
      console.log(`✅ [ShopifyRotation] Proactive token refresh successful for ${clientId}`);
      return { success: true };
    }
    const reconciled = await reconcileShopifyConnection(clientId, { tryRefresh: true });
    if (reconciled.connected) {
      return { success: true };
    }
    return { success: false, error: refreshResult.reason || reconciled.reason || 'refresh_failed' };
  } catch (error) {
    console.error(`❌ [ShopifyRotation] Proactive token refresh failed for ${client?.clientId}:`, error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
    getShopifyClient,
    withShopifyRetry,
    refreshShopifyToken,
    injectPixelScript: async (clientId, backendUrl) => {
        return await withShopifyRetry(clientId, async (shop) => {
            const client = await Client.findOne({ clientId });
            
            // 1. Get Main Theme
            const themesRes = await shop.get('/themes.json');
            const mainTheme = (themesRes.data.themes || []).find(t => t.role === 'main');
            if (!mainTheme) throw new Error('Main theme not found');

            // 2. Get theme.liquid
            const assetRes = await shop.get(`/themes/${mainTheme.id}/assets.json`, {
                params: { 'asset[key]': 'layout/theme.liquid' }
            });
            let liquid = assetRes.data.asset?.value;
            if (!liquid) throw new Error('Could not read theme.liquid');

            const finalBackendUrl =
                backendUrl || process.env.BACKEND_URL || process.env.SERVER_URL || 'https://api.topedgeai.com';
            const scriptTag = `\n<!-- TopEdge Pixel -->\n<script src="${finalBackendUrl}/api/shopify-pixel/pixel/${clientId}/script.js" async></script>\n`;

            if (liquid.includes(`/api/shopify-pixel/pixel/${clientId}/script.js`)) {
                return { success: true, message: 'Pixel already injected' };
            }

            // 3. Inject before </body> (preferred) or </head>
            if (liquid.includes('</body>')) {
                liquid = liquid.replace('</body>', `${scriptTag}</body>`);
            } else if (liquid.includes('</head>')) {
                liquid = liquid.replace('</head>', `${scriptTag}</head>`);
            } else {
                liquid += scriptTag;
            }

            // 4. Save
            await shop.put(`/themes/${mainTheme.id}/assets.json`, {
                asset: { key: 'layout/theme.liquid', value: liquid }
            });

            return { success: true };
        });
    },

    verifyThemeHasPixelScript: async (clientId) => {
        return await withShopifyRetry(clientId, async (shop) => {
            const themesRes = await shop.get('/themes.json');
            const mainTheme = (themesRes.data.themes || []).find((t) => t.role === 'main');
            if (!mainTheme) {
                return { found: false, error: 'Main theme not found' };
            }

            const assetRes = await shop.get(`/themes/${mainTheme.id}/assets.json`, {
                params: { 'asset[key]': 'layout/theme.liquid' },
            });
            const liquid = assetRes.data.asset?.value || '';
            const marker = `/api/shopify-pixel/pixel/${clientId}/script.js`;

            return {
                found: liquid.includes(marker),
                themeId: mainTheme.id,
                themeName: mainTheme.name,
            };
        });
    },

    removePixelScript: async (clientId, backendUrl) => {
        return await withShopifyRetry(clientId, async (shop) => {
            const themesRes = await shop.get('/themes.json');
            const mainTheme = (themesRes.data.themes || []).find((t) => t.role === 'main');
            if (!mainTheme) throw new Error('Main theme not found');

            const assetRes = await shop.get(`/themes/${mainTheme.id}/assets.json`, {
                params: { 'asset[key]': 'layout/theme.liquid' },
            });
            let liquid = assetRes.data.asset?.value;
            if (!liquid) throw new Error('Could not read theme.liquid');

            const finalBackendUrl =
                backendUrl || process.env.BACKEND_URL || process.env.SERVER_URL || 'https://api.topedgeai.com';
            const marker = `/api/shopify-pixel/pixel/${clientId}/script.js`;
            if (!liquid.includes(marker)) {
                return { success: true, removed: false, message: 'Theme script not found in theme.liquid' };
            }

            const blockRe = new RegExp(
                `\\n?<!-- TopEdge Pixel -->\\s*\\n?<script[^>]*${clientId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*script\\.js[^>]*>\\s*</script>\\s*`,
                'gi'
            );
            liquid = liquid.replace(blockRe, '\n');
            liquid = liquid.replace(
                new RegExp(
                    `<script[^>]*${clientId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*script\\.js[^>]*>\\s*</script>\\s*`,
                    'gi'
                ),
                ''
            );

            await shop.put(`/themes/${mainTheme.id}/assets.json`, {
                asset: { key: 'layout/theme.liquid', value: liquid },
            });

            return { success: true, removed: true, message: 'Storefront tracking script removed from theme.liquid' };
        });
    },

    /**
     * Phase 3: Dynamic Discount Generator
     * Creates a unique Shopify discount code for a specific customer.
     */
    generatePriceRuleAndDiscount: async (clientId, discountPercent = 10, suffix = 'SAVE') => {
        return await withShopifyRetry(clientId, async (shop) => {
            const code = `${suffix}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
            const now = new Date();
            
            // 1. Create Price Rule
            const priceRuleRes = await shop.post('/price_rules.json', {
                price_rule: {
                    title: `Abandoned Cart ${discountPercent}% - ${code}`,
                    target_type: "line_item",
                    target_selection: "all",
                    allocation_method: "across",
                    value_type: "percentage",
                    value: `-${discountPercent}.0`,
                    customer_selection: "all",
                    starts_at: now.toISOString(),
                    ends_at: new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(), // 48h expiry
                    usage_limit: 1
                }
            });

            const priceRuleId = priceRuleRes.data.price_rule.id;

            // 2. Create Discount Code
            const discountRes = await shop.post(`/price_rules/${priceRuleId}/discount_codes.json`, {
                discount_code: { code }
            });

            return {
                code: discountRes.data.discount_code.code,
                priceRuleId
            };
        });
    }
};
