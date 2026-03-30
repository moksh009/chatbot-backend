const axios = require('axios');
const Client = require('../models/Client');

/**
 * Robust Shopify Client Generator with Auto-Refresh
 * Standardizes API communication and handles OAuth token rotation automatically.
 */
async function getShopifyClient(clientId) {
    const client = await Client.findOne({ clientId });
    if (!client) throw new Error('Client not found');

    let token = client.shopifyAccessToken;
    const domain = client.shopDomain;
    const apiVersion = client.shopifyApiVersion || '2024-01';

    // 1. Check if token needs refresh
    // We refresh if token is within 5 minutes of expiry OR if it's missing but we have credentials
    const fiveMinutes = 5 * 60 * 1000;
    const isNextToExpiry = client.shopifyTokenExpiresAt && (new Date(client.shopifyTokenExpiresAt).getTime() - Date.now()) < fiveMinutes;
    const hasCredentials = client.shopifyClientId && client.shopifyClientSecret;

    if (isNextToExpiry || (!token && hasCredentials)) {
        console.log(`[ShopifyRotation] Renewer triggered for ${clientId}...`);
        try {
            let res;
            if (client.shopifyRefreshToken) {
                // Scenario A: Standard OAuth Refresh Hub (Public/Custom with rotation)
                res = await axios.post(`https://${domain}/admin/oauth/access_token`, {
                    client_id: client.shopifyClientId,
                    client_secret: client.shopifyClientSecret,
                    grant_type: 'refresh_token',
                    refresh_token: client.shopifyRefreshToken
                });
            } else if (hasCredentials) {
                // Scenario B: Client Credentials Re-Auth (Custom Apps with stable credentials)
                res = await axios.post(`https://${domain}/admin/oauth/access_token`, {
                    client_id: client.shopifyClientId,
                    client_secret: client.shopifyClientSecret,
                    grant_type: 'client_credentials'
                });
            }

            if (res?.data?.access_token) {
                token = res.data.access_token;
                client.shopifyAccessToken = token;
                client.shopifyRefreshToken = res.data.refresh_token || client.shopifyRefreshToken;
                if (res.data.expires_in) {
                    client.shopifyTokenExpiresAt = new Date(Date.now() + (res.data.expires_in * 1000));
                } else {
                    client.shopifyTokenExpiresAt = null; 
                }
                await client.save();
                console.log(`✅ [ShopifyRotation] Token renewed successfully for ${clientId}`);
            }
        } catch (err) {
            console.error(`❌ [ShopifyRotation] Renewal failed for ${clientId}:`, err.response?.data || err.message);
            // If it's a 401/403 and we have credentials, we might need a full reconnect, but for now we fallback
        }
    }

    if (!token || !domain) throw new Error('Shopify credentials incomplete');

    return axios.create({
        baseURL: `https://${domain}/admin/api/${apiVersion}`,
        headers: { 
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
        }
    });
}

/**
 * Handle initial OAuth exchange and setup
 */
async function exchangeShopifyToken(clientId, shopDomain, shopifyClientId, shopifyClientSecret, code) {
    const cleanDomain = shopDomain.replace('https://', '').replace('http://', '').split('/')[0];
    
    // Shopify allows grant_type: 'client_credentials' for certain private apps, 
    // but standard OAuth uses 'authorization_code'. We support both based on 'code' presence.
    const payload = {
        client_id: shopifyClientId,
        client_secret: shopifyClientSecret,
        grant_type: code ? 'authorization_code' : 'client_credentials'
    };
    if (code) payload.code = code;

    const res = await axios.post(`https://${cleanDomain}/admin/oauth/access_token`, payload);
    const { access_token, refresh_token, expires_in, scope } = res.data;

    const update = {
        shopifyAccessToken: access_token,
        shopifyRefreshToken: refresh_token || "",
        shopifyScopes: scope || "",
        shopifyClientId,
        shopifyClientSecret,
        shopDomain: cleanDomain
    };

    if (expires_in) {
        update.shopifyTokenExpiresAt = new Date(Date.now() + expires_in * 1000);
    }

    return await Client.findOneAndUpdate({ clientId }, { $set: update }, { new: true });
}

module.exports = {
    getShopifyClient,
    exchangeShopifyToken
};
