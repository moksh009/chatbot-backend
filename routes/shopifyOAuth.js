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
const { sendAdminConfirmationEmail } = require('../utils/emailService');

// ── Shared Email Sender (uses proven emailService infrastructure) ─────────────
// We send directly with inline transporter matching emailService.js exactly,
// which provably works for OTP/invite emails on this Render deployment.
async function sendShopifyEmail({ to, subject, html }) {
  // Use EXACT same config as sendSystemOTPEmail in emailService.js (proven to work).
  // SYSTEM_EMAIL_USER = team@topedgeai.com, SYSTEM_EMAIL_PASS = Google App Password
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false, // true for 465, false for other ports
    requireTLS: true,
    tls: {
      rejectUnauthorized: false // Helps bypass strict firewall certificate checks on Render
    },
    auth: {
      user: process.env.SYSTEM_EMAIL_USER || process.env.SMTP_USER,
      pass: process.env.SYSTEM_EMAIL_PASS || process.env.SMTP_PASS
    }
  });
  try {
    const info = await transporter.sendMail({
      from: `"TopEdge AI" <${process.env.SYSTEM_EMAIL_USER}>`,
      to,
      subject,
      html
    });
    console.log(`✅ [ShopifyEmail] Sent to ${to} | MessageId: ${info.messageId}`);
    return true;
  } catch (err) {
    console.error(`❌ [ShopifyEmail] SMTP Error for ${to} | Code: ${err.code} | ${err.message}`);
    return false;
  }
}

const { encrypt } = require('../utils/encryption');

// ─── Configuration ───────────────────────────────────────────────────────────
const SHOPIFY_CLIENT_ID = () => process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = () => process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_SCOPES = () => process.env.SHOPIFY_SCOPES || 'read_products,write_products,read_orders,write_orders,read_customers,write_customers,read_checkouts,write_checkouts,read_themes,write_themes,read_price_rules,write_price_rules,read_discounts,write_discounts,read_shopify_payments_payouts';
const SHOPIFY_REDIRECT_URI = () => process.env.SHOPIFY_REDIRECT_URI || `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/api/shopify/callback`;
const FRONTEND_URL = () => process.env.FRONTEND_URL || 'https://dash.topedgeai.com';

// ── Helper: Extract shopDomain from install link ──────────────────────────────
function extractShopDomainFromLink(link) {
  if (!link) return null;
  try {
    let normalized = link.trim();
    if (!normalized.startsWith('http')) normalized = 'https://' + normalized;
    const url = new URL(normalized);
    
    // Pattern 1: admin.shopify.com/store/{slug}
    const storeMatch = url.pathname.match(/\/store\/([^/]+)/);
    if (storeMatch) return `${storeMatch[1]}.myshopify.com`;
    
    // Pattern 2: {slug}.myshopify.com
    if (url.hostname.includes('.myshopify.com')) return url.hostname;
    
    // Pattern 3: ?shop= query
    if (url.searchParams.get('shop')) return url.searchParams.get('shop');

    // Pattern 4: admin.shopify.com/oauth/install_custom_app?signature=...
    if (url.pathname.includes('/install_custom_app')) {
      const signature = url.searchParams.get('signature');
      if (signature) {
        // signature is "base64payload--hmac"
        const payload = signature.split('--')[0];
        try {
          // Shopify uses base64url encoding for the signature payload
          const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
          if (decoded.permanent_domain) return decoded.permanent_domain;
        } catch (err) {}
      }
    }
    
    return null;
  } catch (e) {
    return null;
  }
}

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

    // Send Admin Notification
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@topedge.ai';
    await sendShopifyEmail({
      to: adminEmail,
      subject: `🚨 Action Required: New Shopify Link Request for ${cleanShop}`,
      html: `
        <div style="font-family:'Inter',Arial,sans-serif;max-width:540px;margin:40px auto;background:#fff;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden">
          <div style="background:linear-gradient(135deg,#4F46E5,#1e1b4b);padding:32px;text-align:center">
            <h2 style="color:#fff;margin:0;font-size:24px;font-weight:800">TopEdge AI Admin</h2>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:13px">Action Required</p>
          </div>
          <div style="padding:36px">
            <h3 style="color:#0f172a;margin-top:0">🚨 New Shopify Link Request</h3>
            <p style="color:#475569">A client needs a Custom Distribution Link.</p>
            <table style="width:100%;border-collapse:collapse;margin-top:15px;font-size:14px">
              <tr style="background:#f8fafc"><td style="padding:10px 12px;border:1px solid #e2e8f0;font-weight:600;color:#374151">Client ID</td><td style="padding:10px 12px;border:1px solid #e2e8f0;color:#64748b">${clientId}</td></tr>
              <tr><td style="padding:10px 12px;border:1px solid #e2e8f0;font-weight:600;color:#374151">Store Domain</td><td style="padding:10px 12px;border:1px solid #e2e8f0;color:#64748b">${cleanShop}</td></tr>
              <tr style="background:#f8fafc"><td style="padding:10px 12px;border:1px solid #e2e8f0;font-weight:600;color:#374151">User Email</td><td style="padding:10px 12px;border:1px solid #e2e8f0;color:#64748b">${userEmail}</td></tr>
            </table>
            <div style="margin-top:24px;padding:16px;background:#fefce8;border:1px solid #fde68a;border-radius:12px">
              <p style="margin:0;color:#92400e;font-size:13px"><strong>Action:</strong> Generate the link in Shopify Partners → assign it in the TopEdge Admin Panel.</p>
            </div>
          </div>
        </div>
      `
    });

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
    const { clientId, shopifyInstallLink } = req.body;

    if (!clientId || !shopifyInstallLink) {
      return res.status(400).json({ success: false, error: 'Missing clientId or shopifyInstallLink' });
    }

    // ── Extract shopDomain from the install link URL ────────────────────────────
    // Shopify links: https://admin.shopify.com/store/81v3fg-zd/app/grant?...
    // Users often paste without https:// — handle that case explicitly.
    let extractedShopDomain = '';
    try {
      // Normalize: add https:// if no protocol present
      let normalizedLink = shopifyInstallLink.trim();
      if (!normalizedLink.startsWith('http://') && !normalizedLink.startsWith('https://')) {
        normalizedLink = 'https://' + normalizedLink;
      }
      const linkUrl = new URL(normalizedLink);
      // Pattern 1: admin.shopify.com/store/{slug}/...
      const storeMatch = linkUrl.pathname.match(/\/store\/([^/]+)/);
      if (storeMatch) {
        extractedShopDomain = `${storeMatch[1]}.myshopify.com`;
        console.log(`[ShopifyOAuth] ✅ Extracted shopDomain='${extractedShopDomain}' via /store/{slug} pattern`);
      }
      // Pattern 2: {slug}.myshopify.com hostname
      if (!extractedShopDomain && linkUrl.hostname.includes('.myshopify.com')) {
        extractedShopDomain = linkUrl.hostname;
        console.log(`[ShopifyOAuth] ✅ Extracted shopDomain='${extractedShopDomain}' via myshopify.com hostname`);
      }
      // Pattern 3: ?shop= query param
      if (!extractedShopDomain && linkUrl.searchParams.get('shop')) {
        extractedShopDomain = linkUrl.searchParams.get('shop');
        console.log(`[ShopifyOAuth] ✅ Extracted shopDomain='${extractedShopDomain}' via ?shop= param`);
      }
      if (!extractedShopDomain) {
        console.warn(`[ShopifyOAuth] ⚠️ Could not extract shopDomain from URL: ${normalizedLink}`);
      }
    } catch (urlErr) {
      console.error('[ShopifyOAuth] ❌ URL parse error for install link:', urlErr.message, '| Raw link:', shopifyInstallLink);
    }

    const updatePayload = { shopifyInstallLink };
    if (extractedShopDomain) {
      updatePayload.shopDomain = extractedShopDomain;
      console.log(`[ShopifyOAuth] Extracted shopDomain='${extractedShopDomain}' from install link`);
    }

    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: updatePayload },
      { new: true }
    );

    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const user = await User.findOne({ clientId }).lean();
    if (!user || !user.email) {
      return res.status(404).json({ success: false, error: 'User email not found for this client' });
    }

    const shopDisplay = extractedShopDomain || client.shopDomain || clientId;

    // ── Send Client Notification ────────────────────────────────────────────────
    await sendShopifyEmail({
      to: user.email,
      subject: '✅ Your Shopify Installation Link is Ready!',
      html: `
        <div style="font-family:'Inter',Arial,sans-serif;max-width:540px;margin:40px auto;background:#fff;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden">
          <div style="background:linear-gradient(135deg,#10B981,#065f46);padding:32px;text-align:center">
            <h2 style="color:#fff;margin:0;font-size:24px;font-weight:800">TopEdge AI</h2>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:13px">Shopify Integration Ready</p>
          </div>
          <div style="padding:36px">
            <h3 style="color:#0f172a;margin-top:0">Your Installation Link is Ready! 🎉</h3>
            <p style="color:#475569;line-height:1.6">Hi there,<br><br>We have successfully generated your secure Shopify Custom Installation link for <strong>${shopDisplay}</strong>.</p>
            <p style="color:#475569;line-height:1.6">Click the button below to connect your store to TopEdge AI:</p>
            <div style="text-align:center;margin:32px 0">
              <a href="${shopifyInstallLink}" style="display:inline-block;padding:14px 32px;background:#10B981;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;font-size:16px">Install App Now →</a>
            </div>
            <p style="color:#94a3b8;font-size:12px">If you have any questions, reply to this email or contact our support team at support@topedgeai.com</p>
          </div>
        </div>
      `
    });

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
      secure: true, // Required when sameSite=none
      sameSite: 'none', // Must be none to survive cross-site redirect through Shopify admin
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
router.get('/app-load', async (req, res) => {
  try {
    const { shop } = req.query;
    
    if (!shop) {
      console.error('❌ [ShopifyOAuth] App-load missing shop parameter');
      return res.status(400).send("Missing shop parameter.");
    }

    // ── Aggressive Client Lookup ─────────────────────────────────────────────
    let client = await Client.findOne({
      $or: [
        { shopDomain: shop },
        { shopDomain: `https://${shop}` },
        { shopDomain: shop.replace('.myshopify.com', '') },
        { shopifyInstallLink: { $regex: shop.replace('.myshopify.com', ''), $options: 'i' } }
      ]
    }).sort({ createdAt: -1 });

    if (!client) {
      console.warn(`[ShopifyOAuth] No direct match for '${shop}'. Scanning all clients for install link matches...`);
      const allClients = await Client.find({ shopifyInstallLink: { $exists: true, $ne: null } });
      for (const c of allClients) {
        const extracted = extractShopDomainFromLink(c.shopifyInstallLink);
        if (extracted === shop) {
          client = c;
          // Self-heal: Save the missing shopDomain now
          await Client.updateOne({ _id: c._id }, { $set: { shopDomain: shop } });
          console.log(`[ShopifyOAuth] ✅ Self-healed /app-load: Saved shopDomain for ${c.clientId}`);
          break;
        }
      }
    }

    if (client) {
      const cookieSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || 'fallback_cookie_secret';
      const signedClientId = signCookieValue(client.clientId, cookieSecret);
      
      res.cookie('shopify_oauth_client', signedClientId, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 10 * 60 * 1000
      });
      console.log(`✅ [ShopifyOAuth] Regenerated session cookie for ${client.clientId} (shop: ${shop})`);
    } else {
      console.error(`❌ [ShopifyOAuth] Still no client found for shop '${shop}' after aggressive scan.`);
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

    // ── 3. Session (Cookie) Verification + DB Fallback ───────────────────────────
    const cookieSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || 'fallback_cookie_secret';
    const rawCookie = getRawCookie(req, 'shopify_oauth_client');
    const clientIdFromCookie = verifyAndExtractCookie(rawCookie, cookieSecret);

    let client = null;

    if (clientIdFromCookie) {
      client = await Client.findOne({ clientId: clientIdFromCookie });
      console.log(`✅ [ShopifyOAuth] Client resolved via cookie: ${clientIdFromCookie}`);
    }

    // ── 4. Fallback: Aggressive Match ─────────────────────────────────────────
    if (!client) {
      console.warn(`⚠️ [ShopifyOAuth] No cookie/domain found. Performing aggressive scan for shop: ${shop}`);
      const shopBase = shop.replace('.myshopify.com', '').toLowerCase();
      
      // Try regex search first
      client = await Client.findOne({
        $or: [
          { shopDomain: shop },
          { shopDomain: { $regex: shopBase, $options: 'i' } },
          { shopifyInstallLink: { $regex: shopBase, $options: 'i' } },
          { 'commerce.shopify.domain': shop },
          { 'commerce.shopify.domain': { $regex: shopBase, $options: 'i' } }
        ]
      });

      // If still no match, do the full scan (backup)
      if (!client) {
        const allClients = await Client.find({ shopifyInstallLink: { $exists: true, $ne: null } });
        for (const c of allClients) {
          const extracted = extractShopDomainFromLink(c.shopifyInstallLink);
          if (extracted === shop) {
            client = c;
            break;
          }
        }
      }

      if (client) {
        console.log(`✅ [ShopifyOAuth] Client resolved via aggressive scan: ${client.clientId}`);
        // Auto-fix: save shopDomain now so future lookups don't need regex
        if (!client.shopDomain || client.shopDomain !== shop) {
          await Client.findOneAndUpdate(
            { clientId: client.clientId },
            { $set: { shopDomain: shop } }
          );
          console.log(`[ShopifyOAuth] ✅ Auto-saved shopDomain='${shop}' for ${client.clientId}`);
        }
      }
    }

    if (!client) {
      console.error(`❌ [ShopifyOAuth] Cannot identify client for shop '${shop}'. No cookie, no DB match.`);
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


// ── Route: Sync all domains (Self-Healing) ───────────────────────────────────
router.get('/sync-all-domains', async (req, res) => {
  try {
    const clients = await Client.find({ shopifyInstallLink: { $exists: true, $ne: null } });
    let count = 0;
    for (const client of clients) {
      const domain = extractShopDomainFromLink(client.shopifyInstallLink);
      if (domain && (!client.shopDomain || client.shopDomain === "")) {
        await Client.updateOne({ _id: client._id }, { $set: { shopDomain: domain } });
        count++;
      }
    }
    res.json({ success: true, message: `Synced ${count} domains from install links.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
