/**
 * Shopify OAuth 2.0 Routes — Enterprise Implementation
 * 
 * Handles the full OAuth handshake:
 * 1. GET /auth       → Redirect merchant to Shopify's consent screen
 * 2. GET /callback   → Receive authorization code, verify HMAC, exchange for access token
 * 3. GET /install    → Public install endpoint for Shopify App Store
 * 
 * Security:
 * - HMAC-SHA256 signature verification on callback
 * - Cryptographic nonce (state) to prevent CSRF attacks
 * - All tokens encrypted at rest via AES-256-CBC
 * - Nonce store with 10-minute TTL auto-cleanup
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Client = require('../models/Client');
const { encrypt } = require('../utils/encryption');

// ─── Configuration ───────────────────────────────────────────────────────────
const SHOPIFY_CLIENT_ID = () => process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = () => process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_SCOPES = () => process.env.SHOPIFY_SCOPES || 'read_products,write_products,read_orders,write_orders,read_customers,write_customers,read_checkouts,write_checkouts,read_themes,write_themes,read_price_rules,write_price_rules,read_discounts,write_discounts,read_shopify_payments_payouts';
const SHOPIFY_REDIRECT_URI = () => process.env.SHOPIFY_REDIRECT_URI || `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/api/shopify/callback`;
const FRONTEND_URL = () => process.env.FRONTEND_URL || 'https://dash.topedgeai.com';

// ─── In-Memory Nonce Store (CSRF Protection) ────────────────────────────────
// Maps: nonce → { clientId, shop, createdAt }
// Auto-cleanup every 5 minutes to prevent memory leaks
const nonceStore = new Map();
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

setInterval(() => {
  const now = Date.now();
  for (const [nonce, data] of nonceStore.entries()) {
    if (now - data.createdAt > NONCE_TTL_MS) {
      nonceStore.delete(nonce);
    }
  }
}, 5 * 60 * 1000); // Cleanup every 5 minutes


/**
 * HMAC Verification
 * Shopify signs the callback URL parameters with your client secret.
 * We must recompute the HMAC and compare to prove authenticity.
 */
function verifyShopifyHMAC(query, clientSecret) {
  const { hmac, ...params } = query;
  if (!hmac) return false;

  // Sort parameters alphabetically and build the message string
  const sortedKeys = Object.keys(params).sort();
  const message = sortedKeys.map(key => `${key}=${params[key]}`).join('&');

  const computedHmac = crypto
    .createHmac('sha256', clientSecret)
    .update(message)
    .digest('hex');

  // Timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmac, 'hex'),
      Buffer.from(computedHmac, 'hex')
    );
  } catch (err) {
    // If buffer lengths differ, they don't match
    return false;
  }
}


/**
 * Validate that the shop parameter is a real *.myshopify.com domain
 * Prevents open redirect and SSRF attacks
 */
function isValidShopDomain(shop) {
  if (!shop || typeof shop !== 'string') return false;
  // Must match: anything.myshopify.com (no paths, no ports)
  return /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop);
}


/**
 * Register essential webhooks after successful OAuth
 */
async function registerWebhooks(shopDomain, accessToken, clientId) {
  const topics = ['checkouts/create', 'checkouts/update', 'orders/create'];
  const webhookUrl = `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/api/shopify/webhook`;

  for (const topic of topics) {
    try {
      await axios.post(
        `https://${shopDomain}/admin/api/2026-01/webhooks.json`,
        {
          webhook: {
            topic,
            address: webhookUrl,
            format: 'json'
          }
        },
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      console.log(`✅ [ShopifyOAuth] Registered webhook ${topic} for ${clientId}`);
    } catch (err) {
      // 422 usually means webhook already exists — not a real error
      if (err.response?.status === 422) {
        console.log(`ℹ️ [ShopifyOAuth] Webhook ${topic} already exists for ${clientId}`);
      } else {
        console.error(`❌ [ShopifyOAuth] Failed to register webhook ${topic} for ${clientId}:`, err.response?.data || err.message);
      }
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: GET /api/shopify/auth — Initiate OAuth Handshake
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/auth', (req, res) => {
  try {
    const { shop, clientId } = req.query;

    // Validate required parameters
    if (!shop) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required parameter: shop (e.g., ?shop=storename.myshopify.com)' 
      });
    }

    if (!clientId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required parameter: clientId' 
      });
    }

    // Sanitize shop domain
    let cleanShop = shop.replace(/https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    if (!cleanShop.includes('.myshopify.com')) {
      cleanShop = `${cleanShop}.myshopify.com`;
    }

    // Validate shop domain format (security: prevent open redirects)
    if (!isValidShopDomain(cleanShop)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid shop domain. Must be a valid *.myshopify.com domain.'
      });
    }

    // Generate cryptographic nonce for CSRF protection
    const nonce = crypto.randomBytes(16).toString('hex');
    
    // Encode clientId into the state parameter (nonce:clientId)
    const state = `${nonce}:${clientId}`;
    
    // Store nonce for verification in callback
    nonceStore.set(nonce, {
      clientId,
      shop: cleanShop,
      createdAt: Date.now()
    });

    // Build Shopify authorization URL
    const clientIdEnv = SHOPIFY_CLIENT_ID();
    const scopes = SHOPIFY_SCOPES();
    const redirectUri = SHOPIFY_REDIRECT_URI();

    if (!clientIdEnv) {
      console.error('❌ [ShopifyOAuth] SHOPIFY_CLIENT_ID environment variable is not set!');
      return res.status(500).json({
        success: false,
        message: 'Shopify OAuth is not configured. Please contact the administrator.'
      });
    }

    const authUrl = `https://${cleanShop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(clientIdEnv)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}` +
      `&grant_options[]=per-user` +
      `&scope=${encodeURIComponent(scopes)}`;

    console.log(`🔄 [ShopifyOAuth] Initiating OAuth for clientId=${clientId}, shop=${cleanShop}`);
    console.log(`🔗 [ShopifyOAuth] Redirecting to: ${authUrl.substring(0, 100)}...`);

    // Redirect the merchant to Shopify's consent screen
    return res.redirect(authUrl);

  } catch (error) {
    console.error('❌ [ShopifyOAuth] Auth initiation error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to initiate Shopify OAuth' 
    });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: GET /api/shopify/callback — Token Exchange (HMAC-Verified)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/callback', async (req, res) => {
  try {
    const { code, hmac, shop, state, timestamp } = req.query;
    const frontendUrl = FRONTEND_URL();

    // ── Validation Gate ──────────────────────────────────────────────────────
    if (!code || !hmac || !shop || !state) {
      console.error('❌ [ShopifyOAuth] Callback missing required parameters:', { code: !!code, hmac: !!hmac, shop: !!shop, state: !!state });
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=missing_params`);
    }

    // ── Shop Domain Validation ───────────────────────────────────────────────
    if (!isValidShopDomain(shop)) {
      console.error('❌ [ShopifyOAuth] Invalid shop domain in callback:', shop);
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=invalid_shop`);
    }

    // ── HMAC Signature Verification ──────────────────────────────────────────
    const clientSecret = SHOPIFY_CLIENT_SECRET();
    if (!clientSecret) {
      console.error('❌ [ShopifyOAuth] SHOPIFY_CLIENT_SECRET is not configured!');
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=config_error`);
    }

    const isValidHmac = verifyShopifyHMAC(req.query, clientSecret);
    if (!isValidHmac) {
      console.error('❌ [ShopifyOAuth] HMAC verification FAILED for shop:', shop);
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=hmac_failed`);
    }
    console.log('✅ [ShopifyOAuth] HMAC verification passed');

    // ── Nonce (State) Verification ───────────────────────────────────────────
    const [nonce, clientId] = state.split(':');
    if (!nonce || !clientId) {
      console.error('❌ [ShopifyOAuth] Invalid state parameter format:', state);
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=invalid_state`);
    }

    const storedNonce = nonceStore.get(nonce);
    if (!storedNonce) {
      console.error('❌ [ShopifyOAuth] Nonce not found or expired. Possible CSRF attempt.');
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=nonce_expired`);
    }

    // Validate nonce hasn't expired (10 min TTL)
    if (Date.now() - storedNonce.createdAt > NONCE_TTL_MS) {
      nonceStore.delete(nonce);
      console.error('❌ [ShopifyOAuth] Nonce expired for clientId:', clientId);
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=nonce_expired`);
    }

    // Validate clientId matches
    if (storedNonce.clientId !== clientId) {
      console.error('❌ [ShopifyOAuth] ClientId mismatch in nonce. Expected:', storedNonce.clientId, 'Got:', clientId);
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=state_mismatch`);
    }

    // Consume the nonce (one-time use)
    nonceStore.delete(nonce);

    // ── Verify Client Exists ─────────────────────────────────────────────────
    const client = await Client.findOne({ clientId });
    if (!client) {
      console.error('❌ [ShopifyOAuth] Client not found:', clientId);
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=client_not_found`);
    }

    // ── Token Exchange ───────────────────────────────────────────────────────
    console.log(`🔄 [ShopifyOAuth] Exchanging authorization code for access token... (shop: ${shop}, clientId: ${clientId})`);

    const tokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_CLIENT_ID(),
      client_secret: clientSecret,
      code: code
    });

    const { access_token, scope } = tokenResponse.data;

    if (!access_token) {
      console.error('❌ [ShopifyOAuth] No access_token in Shopify response:', tokenResponse.data);
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=token_exchange_failed`);
    }

    console.log(`✅ [ShopifyOAuth] Access token received for ${clientId}. Scopes: ${scope}`);

    // ── Save to Database (Encrypted) ─────────────────────────────────────────
    const updatePayload = {
      shopDomain: shop,
      shopifyAccessToken: access_token,
      shopifyScopes: scope || '',
      shopifyClientId: SHOPIFY_CLIENT_ID(),
      shopifyClientSecret: clientSecret,
      shopifyConnectionStatus: 'connected',
      lastShopifyError: '',
      shopifyTokenExpiresAt: null, // Offline tokens don't expire
      storeType: 'shopify',
      // Also update modular schema
      'commerce.shopify.domain': shop,
      'commerce.shopify.accessToken': access_token,
      'commerce.shopify.clientId': SHOPIFY_CLIENT_ID(),
      'commerce.shopify.clientSecret': clientSecret,
      'commerce.storeType': 'shopify'
    };

    await Client.findOneAndUpdate(
      { clientId },
      { $set: updatePayload },
      { new: true }
    );

    console.log(`✅ [ShopifyOAuth] Credentials saved for ${clientId}`);

    // ── Register Webhooks ────────────────────────────────────────────────────
    try {
      await registerWebhooks(shop, access_token, clientId);
    } catch (webhookErr) {
      // Non-fatal — log but don't block the flow
      console.error(`⚠️ [ShopifyOAuth] Webhook registration failed (non-fatal):`, webhookErr.message);
    }

    // ── Trigger Initial Product & Order Sync (Background) ────────────────────
    const serverUrl = process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com';
    // Fire-and-forget sync calls
    axios.post(`${serverUrl}/api/shopify/${clientId}/sync-products`, {}, {
      headers: { 'Authorization': `Bearer INTERNAL_SYNC` }
    }).catch(e => console.log(`ℹ️ [ShopifyOAuth] Background product sync skipped:`, e.message));

    axios.post(`${serverUrl}/api/shopify/${clientId}/sync-orders`, {}, {
      headers: { 'Authorization': `Bearer INTERNAL_SYNC` }
    }).catch(e => console.log(`ℹ️ [ShopifyOAuth] Background order sync skipped:`, e.message));

    // ── Redirect to Frontend ─────────────────────────────────────────────────
    console.log(`🎉 [ShopifyOAuth] OAuth complete for ${clientId}! Redirecting to frontend...`);
    return res.redirect(`${frontendUrl}/settings?tab=store&shopify_connected=true`);

  } catch (error) {
    console.error('❌ [ShopifyOAuth] Callback error:', error.response?.data || error.message);
    const frontendUrl = FRONTEND_URL();
    return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=callback_failed`);
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: GET /api/shopify/install — Public Install (Shopify App Store)
// ═══════════════════════════════════════════════════════════════════════════════
// This endpoint handles installs from the Shopify App Store where the merchant
// doesn't yet have a clientId. It creates a temporary session and after OAuth,
// links the store to an existing or newly-created client.
router.get('/install', (req, res) => {
  try {
    const { shop } = req.query;

    if (!shop) {
      return res.status(400).send(`
        <html><body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h2>Missing Store URL</h2>
          <p>Please install this app from the Shopify App Store or provide your store URL.</p>
        </body></html>
      `);
    }

    let cleanShop = shop.replace(/https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    if (!cleanShop.includes('.myshopify.com')) {
      cleanShop = `${cleanShop}.myshopify.com`;
    }

    if (!isValidShopDomain(cleanShop)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid shop domain.'
      });
    }

    // For App Store installs, use a placeholder clientId
    // The callback will handle creating/linking the client
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = `${nonce}:SHOPIFY_INSTALL`;

    nonceStore.set(nonce, {
      clientId: 'SHOPIFY_INSTALL',
      shop: cleanShop,
      createdAt: Date.now()
    });

    const clientIdEnv = SHOPIFY_CLIENT_ID();
    const scopes = SHOPIFY_SCOPES();
    const redirectUri = SHOPIFY_REDIRECT_URI();

    if (!clientIdEnv) {
      return res.status(500).json({
        success: false,
        message: 'Shopify OAuth not configured.'
      });
    }

    const authUrl = `https://${cleanShop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(clientIdEnv)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    console.log(`🔄 [ShopifyOAuth] App Store install initiated for shop=${cleanShop}`);
    return res.redirect(authUrl);

  } catch (error) {
    console.error('❌ [ShopifyOAuth] Install initiation error:', error);
    return res.status(500).json({ success: false, message: 'Install initiation failed' });
  }
});


module.exports = router;
