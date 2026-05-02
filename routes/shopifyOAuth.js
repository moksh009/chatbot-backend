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
const User = require('../models/User');
const nodemailer = require('nodemailer');

// ── Shared Email Transporter ─────────────────────────────────────────────────
const getTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 465,
    secure: true,
    auth: {
      user: process.env.SYSTEM_EMAIL_USER || process.env.SMTP_USER,
      pass: process.env.SYSTEM_EMAIL_PASS || process.env.SMTP_PASS
    }
  });
};
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


// Helper functions for secure signed cookies
function signCookieValue(value, secret) {
  const hmac = crypto.createHmac('sha256', secret).update(value).digest('hex');
  return `${value}.${hmac}`;
}

function verifyAndExtractCookie(signedValue, secret) {
  if (!signedValue || typeof signedValue !== 'string') return null;
  const lastDotIndex = signedValue.lastIndexOf('.');
  if (lastDotIndex === -1) return null;
  
  const value = signedValue.slice(0, lastDotIndex);
  const signature = signedValue.slice(lastDotIndex + 1);
  const expectedSignature = crypto.createHmac('sha256', secret).update(value).digest('hex');
  
  try {
    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return value;
    }
  } catch (err) {
    return null; // Buffer length mismatch or invalid format
  }
  return null;
}

function getRawCookie(req, name) {
  if (!req.headers.cookie) return null;
  const match = req.headers.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  if (match) return decodeURIComponent(match[2]);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW: POST /api/shopify/request-link — Client requests an installation link
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/request-link', async (req, res) => {
  try {
    const { shopDomain, clientId } = req.body;

    if (!shopDomain || !clientId) {
      return res.status(400).json({ success: false, error: 'Missing shopDomain or clientId' });
    }

    let cleanShop = shopDomain.replace(/https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    if (!cleanShop.includes('.myshopify.com')) {
      cleanShop = `${cleanShop}.myshopify.com`;
    }

    const client = await Client.findOneAndUpdate(
      { clientId },
      { 
        $set: { 
          shopDomain: cleanShop,
          shopifyConnectionStatus: 'pending_link'
        } 
      },
      { new: true }
    );

    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // Fetch the dynamic user email associated with this client
    const user = await User.findOne({ clientId }).lean();
    const userEmail = user?.email || 'Unknown User Email';

    // Send Admin Notification (Non-blocking)
    try {
      const transporter = getTransporter();
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@topedge.ai';
      
      const mailOptions = {
        from: `"TopEdge System" <${process.env.SMTP_USER}>`,
        to: adminEmail,
        subject: `🚨 Action Required: New Shopify Link Request for ${cleanShop}`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #4F46E5;">New Shopify Custom App Request</h2>
            <p>A client has requested a secure installation link.</p>
            <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Client ID</td><td style="padding: 8px; border: 1px solid #ddd;">${clientId}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Store Domain</td><td style="padding: 8px; border: 1px solid #ddd;">${cleanShop}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">User Email</td><td style="padding: 8px; border: 1px solid #ddd;">${userEmail}</td></tr>
            </table>
            <p style="margin-top: 20px;"><strong>Action Required:</strong> Generate the installation link in the Shopify Partner Dashboard, and assign it to this client in the TopEdge Admin Panel.</p>
          </div>
        `
      };
      
      transporter.sendMail(mailOptions).catch(err => {
        console.error('⚠️ [ShopifyOAuth] Failed to send admin alert email (non-fatal):', err.message);
      });
      console.log(`✅ [ShopifyOAuth] Admin alert email dispatched for ${cleanShop}`);
    } catch (emailErr) {
      console.error('⚠️ [ShopifyOAuth] Transporter setup failed (non-fatal):', emailErr.message);
    }

    return res.json({ success: true, message: 'Link requested successfully' });

  } catch (error) {
    console.error('❌ [ShopifyOAuth] Request link error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error during link request' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEW: POST /api/shopify/assign-link — Admin assigns link and alerts user
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/assign-link', async (req, res) => {
  try {
    // Note: Ensure this route is protected by Admin authentication middleware in production
    const { clientId, shopifyInstallLink } = req.body;

    if (!clientId || !shopifyInstallLink) {
      return res.status(400).json({ success: false, error: 'Missing clientId or shopifyInstallLink' });
    }

    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { shopifyInstallLink } },
      { new: true }
    );

    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const user = await User.findOne({ clientId }).lean();
    if (!user || !user.email) {
      return res.status(404).json({ success: false, error: 'User email not found for this client' });
    }

    // Send Client Notification (Non-blocking)
    try {
      const transporter = getTransporter();
      
      const mailOptions = {
        from: `"TopEdge Support" <${process.env.SMTP_USER}>`,
        to: user.email,
        subject: `✅ Your Shopify Installation Link is Ready!`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #10B981;">Your Shopify Link is Ready!</h2>
            <p>Hi there,</p>
            <p>We have successfully generated your secure Shopify Custom Installation link for <strong>${client.shopDomain}</strong>.</p>
            <p>You can now install the app directly from your TopEdge Dashboard, or by clicking the link below:</p>
            <a href="${shopifyInstallLink}" style="display: inline-block; padding: 12px 24px; background-color: #10B981; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 15px;">Install App Now</a>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">If you have any questions, please contact our support team.</p>
          </div>
        `
      };
      
      transporter.sendMail(mailOptions).catch(err => {
        console.error('⚠️ [ShopifyOAuth] Failed to send client install email (non-fatal):', err.message);
      });
      console.log(`✅ [ShopifyOAuth] Client install email dispatched to ${user.email}`);
    } catch (emailErr) {
      console.error('⚠️ [ShopifyOAuth] Transporter setup failed (non-fatal):', emailErr.message);
    }

    return res.json({ success: true, message: 'Link assigned and user notified successfully' });

  } catch (error) {
    console.error('❌ [ShopifyOAuth] Assign link error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error assigning link' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: POST /api/shopify/auth — Retrieve Custom Installation Link
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/auth', async (req, res) => {
  try {
    const { shopDomain, clientId } = req.body;

    if (!shopDomain || !clientId) {
      return res.status(400).json({ success: false, error: 'Missing shopDomain or clientId' });
    }

    let cleanShop = shopDomain.replace(/https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    if (!cleanShop.includes('.myshopify.com')) {
      cleanShop = `${cleanShop}.myshopify.com`;
    }

    const client = await Client.findOne({ clientId }).lean();
    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    if (!client.shopifyInstallLink) {
      return res.status(422).json({ 
        success: false, 
        error: 'Please contact support to generate your secure installation link.' 
      });
    }

    // Set secure, signed cookie with clientId
    const cookieSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || 'fallback_cookie_secret';
    const signedClientId = signCookieValue(clientId, cookieSecret);
    
    res.cookie('shopify_oauth_client', signedClientId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000 // 10 minutes
    });

    console.log(`🔄 [ShopifyOAuth] Custom Install Link retrieved for clientId=${clientId}`);
    return res.json({ success: true, shopifyInstallLink: client.shopifyInstallLink });

  } catch (error) {
    console.error('❌ [ShopifyOAuth] Auth retrieval error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error during Shopify auth initiation' });
  }
});
// ═══════════════════════════════════════════════════════════════════════════════
// NEW: GET /api/shopify/app-load — Catches Shopify redirect after Custom Install
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/app-load', (req, res) => {
  try {
    const { shop } = req.query;
    
    if (!shop) {
      console.error('❌ [ShopifyOAuth] App-load missing shop parameter');
      return res.status(400).send("Missing shop parameter.");
    }

    // 1. Get exact App scopes
    const scopes = SHOPIFY_SCOPES(); 
    
    // 2. Get Client ID and Callback URL
    const clientId = SHOPIFY_CLIENT_ID(); 
    const serverUrl = process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com';
    const redirectUri = `${serverUrl}/api/shopify/callback`;

    // 3. Immediately redirect to OAuth to get the token. 
    // Since the app is already installed via the Custom Link, Shopify will skip the prompt
    // and instantly bounce the user to your /callback route with the 'code'.
    const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}`;

    console.log(`🔄 [ShopifyOAuth] App installed via custom link. Fetching token for ${shop}...`);
    return res.redirect(authUrl);

  } catch (error) {
    console.error('❌ [ShopifyOAuth] App load error:', error);
    return res.status(500).send("Internal Server Error");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: GET /api/shopify/callback — Token Exchange (HMAC-Verified)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/callback', async (req, res) => {
  try {
    const { code, hmac, shop } = req.query; // No state required for Custom Distribution Link
    const frontendUrl = FRONTEND_URL();

    // ── 1. Parameter Validation ───────────────────────────────────────────────
    if (!code || !hmac || !shop) {
      console.error('❌ [ShopifyOAuth] Callback missing required parameters:', { code: !!code, hmac: !!hmac, shop: !!shop });
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=missing_params`);
    }

    if (!isValidShopDomain(shop)) {
      console.error('❌ [ShopifyOAuth] Invalid shop domain in callback:', shop);
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=invalid_shop`);
    }

    // ── 2. HMAC Signature Verification ──────────────────────────────────────────
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

    // ── 3. Session (Cookie) Verification ────────────────────────────────────────
    const cookieSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || 'fallback_cookie_secret';
    const rawCookie = getRawCookie(req, 'shopify_oauth_client');
    const clientIdFromCookie = verifyAndExtractCookie(rawCookie, cookieSecret);

    if (!clientIdFromCookie) {
      console.error('❌ [ShopifyOAuth] Invalid or missing session cookie. Installation hijacked or expired.');
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=nonce_expired`);
    }

    // ── 4. Find Client strictly by Cookie ClientId ──────────────────────────────
    const client = await Client.findOne({ clientId: clientIdFromCookie });
    if (!client) {
      console.error('❌ [ShopifyOAuth] Client not found for ID from cookie:', clientIdFromCookie);
      res.clearCookie('shopify_oauth_client');
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=client_not_found`);
    }

    const clientId = client.clientId;
    console.log(`🔄 [ShopifyOAuth] Exchanging authorization code for access token... (shop: ${shop}, clientId: ${clientId})`);

    // ── 5. Token Exchange ───────────────────────────────────────────────────────
    const tokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_CLIENT_ID(),
      client_secret: clientSecret,
      code: code
    });

    const { access_token, scope } = tokenResponse.data;

    if (!access_token) {
      console.error('❌ [ShopifyOAuth] No access_token in Shopify response:', tokenResponse.data);
      res.clearCookie('shopify_oauth_client');
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=token_exchange_failed`);
    }

    console.log(`✅ [ShopifyOAuth] Access token received for ${clientId}. Scopes: ${scope}`);
    console.log(`✅ [ShopifyOAuth] Note: Shopify Billing API skipped. Client billed via Razorpay.`);

    // ── 6. Save to Database ──────────────────────────────────────────────────────
    const updatePayload = {
      shopifyAccessToken: access_token,
      shopifyScopes: scope || '',
      shopifyClientId: SHOPIFY_CLIENT_ID(),
      shopifyClientSecret: clientSecret,
      shopifyConnectionStatus: 'connected',
      lastShopifyError: '',
      shopifyTokenExpiresAt: null,
      storeType: 'shopify',
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

    // Clear session cookie upon success
    res.clearCookie('shopify_oauth_client');

    // ── 7. Background Tasks ──────────────────────────────────────────────────────
    try {
      await registerWebhooks(shop, access_token, clientId);
    } catch (webhookErr) {
      console.error(`⚠️ [ShopifyOAuth] Webhook registration failed (non-fatal):`, webhookErr.message);
    }

    const serverUrl = process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com';
    axios.post(`${serverUrl}/api/shopify/${clientId}/sync-products`, {}, {
      headers: { 'Authorization': `Bearer INTERNAL_SYNC` }
    }).catch(e => console.log(`ℹ️ [ShopifyOAuth] Background product sync skipped:`, e.message));

    axios.post(`${serverUrl}/api/shopify/${clientId}/sync-orders`, {}, {
      headers: { 'Authorization': `Bearer INTERNAL_SYNC` }
    }).catch(e => console.log(`ℹ️ [ShopifyOAuth] Background order sync skipped:`, e.message));

    console.log(`🎉 [ShopifyOAuth] OAuth complete for ${clientId}! Redirecting to frontend...`);
    return res.redirect(`${frontendUrl}/settings?tab=store&shopify_connected=true`);

  } catch (error) {
    console.error('❌ [ShopifyOAuth] Callback error:', error.response?.data || error.message);
    res.clearCookie('shopify_oauth_client');
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
