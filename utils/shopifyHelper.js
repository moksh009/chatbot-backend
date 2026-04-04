const axios = require('axios');
const Client = require('../models/Client');
const { encrypt, decrypt } = require('./encryption');

/**
 * Robust Shopify Client Generator with Auto-Refresh & Self-Healing
 * Standardizes API communication and handles OAuth token rotation automatically.
 */
async function getShopifyClient(clientId, forceRefresh = false) {
    const client = await Client.findOne({ clientId });
    if (!client) throw new Error('Client not found');

    let token = decrypt(client.shopifyAccessToken);
    const domain = client.shopDomain;
    const apiVersion = client.shopifyApiVersion || '2024-01';

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
                    client_id: client.shopifyClientId,
                    client_secret: client.shopifyClientSecret,
                    grant_type: 'refresh_token',
                    refresh_token: decrypt(client.shopifyRefreshToken)
                });

                if (res.data.access_token) {
                    token = res.data.access_token;
                    client.shopifyAccessToken = encrypt(token);
                    client.shopifyRefreshToken = encrypt(res.data.refresh_token || decrypt(client.shopifyRefreshToken));
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

        // Step B: Try Client Credentials (Fallback for Custom Apps or if Refresh Token is dead/revoked)
        if (!success && hasCredentials) {
            try {
                const rotationPayload = {
                    client_id: client.shopifyClientId,
                    client_secret: client.shopifyClientSecret ? '***' + decrypt(client.shopifyClientSecret).slice(-4) : 'MISSING',
                    grant_type: 'client_credentials'
                };
                console.log(`[ShopifyRotation] Rotation Payload for ${clientId}:`, JSON.stringify({ ...rotationPayload, client_secret: '***' }));

                const res = await axios.post(`https://${domain}/admin/oauth/access_token`, {
                    client_id: client.shopifyClientId,
                    client_secret: decrypt(client.shopifyClientSecret),
                    grant_type: 'client_credentials'
                });

                if (res.data.access_token) {
                    token = res.data.access_token;
                    client.shopifyAccessToken = encrypt(token);
                    client.shopifyTokenExpiresAt = null; // Client credentials usually issue semi-permanent tokens
                    success = true;
                    console.log(`✅ [ShopifyRotation] Token restored via Client Credentials for ${clientId}`);
                }
            } catch (err) {
                const eData = err.response?.data;
                lastError = typeof eData === 'string' && eData.length > 200 ? `${eData.substring(0, 100)}... [HTML truncated]` : (eData || err.message);
                console.error(`❌ [ShopifyRotation] Client Credentials attempt failed for ${clientId}:`, JSON.stringify(lastError));
            }
        }

        if (success) {
            client.shopifyConnectionStatus = 'connected';
            client.lastShopifyError = '';
            await client.save();
        } else if (forceRefresh || isNextToExpiry) {
            const errorMsg = `Self-Healing Failed for ${clientId}: ${JSON.stringify(lastError)}`;
            console.error(`❌ [ShopifyRotation] ${errorMsg}`);
            await Client.updateOne({ clientId }, { 
                $set: { 
                    shopifyConnectionStatus: 'error', 
                    lastShopifyError: errorMsg 
                } 
            });
            if (forceRefresh) throw new Error(`Shopify rotation failed: ${JSON.stringify(lastError)}`);
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
        if (err.response?.status === 401 && retryCount < 3) {
            console.warn(`[SelfHealing] 401 detected for ${clientId}. Attempt ${retryCount + 1}/3...`);
            try {
                const shop = await getShopifyClient(clientId, true); 
                console.log(`[SelfHealing] Rotation successful for ${clientId}. Retrying operation...`);
                return await withShopifyRetry(clientId, operation, retryCount + 1);
            } catch (retryErr) {
                console.error(`[SelfHealing] Rotation retry failed for ${clientId}:`, retryErr.message);
                throw retryErr;
            }
        }
        if (retryCount >= 3) {
            console.error(`[SelfHealing] MAX RETRIES reached for ${clientId}. Flagging for manual review.`);
            await Client.updateOne({ clientId }, { $set: { shopifyConnectionStatus: 'error', lastShopifyError: 'Max Retry Failure' } });
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
        shopifyAccessToken: encrypt(access_token),
        shopifyRefreshToken: encrypt(refresh_token || ""),
        shopifyScopes: scope || "",
        shopifyClientId,
        shopifyClientSecret: encrypt(shopifyClientSecret),
        shopDomain: cleanDomain,
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
    injectPixelScript: async (clientId) => {
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

            const backendUrl = process.env.BACKEND_URL || 'https://topedgeai.com';
            const scriptTag = `\n<!-- TopEdge Pixel -->\n<script src="${backendUrl}/api/shopify/pixel/${clientId}/script.js"></script>\n`;

            if (liquid.includes(`/api/shopify/pixel/${clientId}/script.js`)) {
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
    }
};
