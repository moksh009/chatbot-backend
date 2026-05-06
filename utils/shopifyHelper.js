const axios = require('axios');
const Client = require('../models/Client');
const { encrypt, decrypt } = require('./encryption');
const shopifyAdminApiVersion = require('./shopifyAdminApiVersion');

/**
 * Robust Shopify Client Generator with Auto-Refresh & Self-Healing
 * Standardizes API communication and handles OAuth token rotation automatically.
 */
async function getShopifyClient(clientId, forceRefresh = false) {
    const client = await Client.findOne({ clientId });
    if (!client) throw new Error('Client not found');

    let token = decrypt(client.shopifyAccessToken);
    const domain = client.shopDomain;
    const apiVersion = client.shopifyApiVersion || shopifyAdminApiVersion;

    // STRICT VALIDATION: Prevent OAuth requests to invalid domains which cause HTML crashes
    if (!domain || domain.includes('your-store') || !domain.includes('.')) {
        console.error(`❌ [ShopifyClient] Invalid or missing domain for ${clientId}: ${domain}`);
        throw new Error('Shopify credentials incomplete or invalid domain configuration');
    }

    // 1. Check if token needs refresh
    const fiveMinutes = 5 * 60 * 1000;
    const isNextToExpiry = client.shopifyTokenExpiresAt && (new Date(client.shopifyTokenExpiresAt).getTime() - Date.now()) < fiveMinutes;
    const hasCredentials = client.shopifyClientId && client.shopifyClientSecret;

    // FORCE: If forceRefresh is true, we ignore the current token and fetch a new one
    if (forceRefresh || isNextToExpiry || (!token && hasCredentials)) {
        console.log(`[ShopifyRotation] ${forceRefresh ? 'FORCED' : 'Auto'} Renewer triggered for ${clientId}...`);
        
        let success = false;
        let lastError = null;

        // --- SEQUENTIAL RECOVERY FLOW ---
        
        // Step A: Try Refresh Token (Standard OAuth)
        if (client.shopifyRefreshToken) {
            try {
                console.log(`[ShopifyRotation] Attempting Refresh Token rotation for ${clientId}...`);
                const res = await axios.post(`https://${domain}/admin/oauth/access_token`, {
                    client_id: decrypt(client.shopifyClientId),
                    client_secret: decrypt(client.shopifyClientSecret),
                    grant_type: 'refresh_token',
                    refresh_token: decrypt(client.shopifyRefreshToken)
                });

                if (res.data.access_token) {
                    token = res.data.access_token;
                    client.shopifyAccessToken = token;
                    client.shopifyRefreshToken = res.data.refresh_token || decrypt(client.shopifyRefreshToken);
                    
                    if (!client.commerce) client.commerce = {};
                    if (!client.commerce.shopify) client.commerce.shopify = {};
                    client.commerce.shopify.accessToken = token;
                    client.commerce.shopify.refreshToken = res.data.refresh_token || decrypt(client.shopifyRefreshToken);
                    if (res.data.expires_in) {
                        client.shopifyTokenExpiresAt = new Date(Date.now() + (res.data.expires_in * 1000));
                    } else {
                        client.shopifyTokenExpiresAt = null; 
                    }
                    success = true;
                    console.log(`✅ [ShopifyRotation] Token restored via Refresh Token for ${clientId}`);
                }
            } catch (err) {
                const eData = err.response?.data;
                lastError = typeof eData === 'string' && eData.length > 200 ? `${eData.substring(0, 100)}... [HTML truncated]` : (eData || err.message);
                console.warn(`[ShopifyRotation] Refresh token attempt failed for ${clientId}:`, JSON.stringify(lastError));
            }
        }



        if (success) {
            client.shopifyConnectionStatus = 'connected';
            client.lastShopifyError = '';
            await client.save();
        } else if (forceRefresh || isNextToExpiry) {
            const errorReason = lastError ? JSON.stringify(lastError) : (hasCredentials && !client.shopifyRefreshToken ? 'Custom App (No Refresh Token)' : 'Unknown');
            const errorMsg = `Self-Healing Failed for ${clientId}: ${errorReason}`;
            console.error(`❌ [ShopifyRotation] ${errorMsg}`);
            await Client.updateOne({ clientId }, { 
                $set: { 
                    shopifyConnectionStatus: 'error', 
                    lastShopifyError: errorMsg 
                } 
            });
            if (forceRefresh) throw new Error(`Shopify rotation failed: ${errorReason}`);
        }
    }

    if (!token || !domain) {
        console.error(`❌ [ShopifyClient] Missing credentials for ${clientId}. Token: ${!!token}, Domain: ${domain}`);
        throw new Error('Shopify credentials incomplete or invalid');
    }

    const instance = axios.create({
        baseURL: `https://${domain}/admin/api/${apiVersion}`,
        headers: { 
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
        }
    });

    instance.interceptors.response.use(
        response => response,
        async (error) => {
            if (error.response?.status === 401) {
                console.warn(`[ShopifyAuth] 401 Unauthorized detected for ${clientId}. Flagging for recovery.`);
                await Client.updateOne(
                    { clientId }, 
                    { $set: { shopifyConnectionStatus: 'error', lastShopifyError: 'Session Expired (401)' } }
                );
            }
            return Promise.reject(error);
        }
    );

    return instance;
}

/**
 * SELF-HEALING WRAPPER
 * Automatically detects 401s, rotates tokens, and retries the request up to 3 times.
 */
async function withShopifyRetry(clientId, operation, retryCount = 0) {
    try {
        const shop = await getShopifyClient(clientId);
        return await operation(shop);
    } catch (err) {
        const isAuthError = err.response?.status === 401;
        const isForbidden = err.response?.status === 403;

        if ((isAuthError || isForbidden) && retryCount < 2) {
            const clientRecord = await Client.findOne({ clientId }).select('shopifyRefreshToken shopifyClientId');
            const cannotAutoRotate =
                clientRecord?.shopifyClientId && !clientRecord?.shopifyRefreshToken;
            if (cannotAutoRotate) {
                const reason = isAuthError ? '401 Unauthorized' : '403 Forbidden';
                console.warn(
                    `[SelfHealing] ${reason} for ${clientId}: skipped token rotation (custom app without OAuth refresh token). Update the Admin API access token in Commerce settings or reconnect the app.`
                );
                throw err;
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
        throw err;
    }
}

/**
 * Handle initial OAuth exchange and setup
 */
async function exchangeShopifyToken(clientId, shopDomain, shopifyClientId, shopifyClientSecret, code) {
    const cleanDomain = shopDomain.replace('https://', '').replace('http://', '').split('/')[0];
    
    // OFFLINE ACCESS: Explicitly request offline access mode
    const payload = {
        client_id: shopifyClientId,
        client_secret: decrypt(shopifyClientSecret),
        grant_type: code ? 'authorization_code' : 'client_credentials'
    };
    if (code) {
        payload.code = code;
        payload['grant_options[]'] = 'offline'; 
    }

    const res = await axios.post(`https://${cleanDomain}/admin/oauth/access_token`, payload);
    const { access_token, refresh_token, expires_in, scope } = res.data;

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

    if (expires_in) {
        update.shopifyTokenExpiresAt = new Date(Date.now() + expires_in * 1000);
    } else {
        update.shopifyTokenExpiresAt = null; 
    }

    return await Client.findOneAndUpdate({ clientId }, { $set: update }, { new: true });
}

async function refreshShopifyToken(client) {
  try {
    console.log(`[ShopifyRotation] Proactively refreshing token for ${client.clientId}...`);
    await getShopifyClient(client.clientId, true); // Force refresh
    console.log(`✅ [ShopifyRotation] Proactive token refresh successful for ${client.clientId}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ [ShopifyRotation] Proactive token refresh failed for ${client.clientId}:`, error.message);
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

            const finalBackendUrl = backendUrl || process.env.BACKEND_URL || 'https://topedgeai.com';
            const scriptTag = `\n<!-- TopEdge Pixel -->\n<script src="${finalBackendUrl}/api/shopify-pixel/pixel/${clientId}/script.js"></script>\n`;

            if (liquid.includes(`/api/shopify-pixel/pixel/${clientId}/script.js`)) {
                return { success: true, message: 'Pixel already injected' };
            }

            // 3. Inject before </head>
            if (liquid.includes('</head>')) {
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
