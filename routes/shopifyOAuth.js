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
const { invalidateClientCache } = require('../utils/core/clientCache');
const { sendAdminConfirmationEmail, deliverSystemEmail } = require('../utils/core/emailService');

// ── Shared system mail — Nodemailer SMTP (same as OTP).
async function sendShopifyEmail({ to, subject, html }) {
  const fromUser = process.env.SYSTEM_EMAIL_USER || process.env.SMTP_USER || '';
  if (!fromUser) {
    console.error('❌ [ShopifyEmail] Missing SYSTEM_EMAIL_USER / SMTP_USER');
    return false;
  }
  const from = `"TopEdge AI" <${fromUser}>`;
  const ok = await deliverSystemEmail({ from, to, subject, html });
  if (ok) console.log(`✅ [ShopifyEmail] Sent to ${to}`);
  else console.error(`❌ [ShopifyEmail] Failed for ${to} — check SYSTEM_EMAIL_* and SMTP_HOST / port 465`);
  return ok;
}

const { encrypt } = require('../utils/core/encryption');
const shopifyAdminApiVersion = require('../utils/shopify/shopifyAdminApiVersion');
const { getShopifyOAuthScopeCsv } = require('../utils/shopify/shopifyScopeUtils');

// ─── Configuration ───────────────────────────────────────────────────────────
const SHOPIFY_CLIENT_ID = () => process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = () => process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_SCOPES = () => getShopifyOAuthScopeCsv().replace(/\s+/g, '');

/**
 * Canonical callback URL — MUST match Shopify Partner Dashboard "Allowed redirection URL(s)" exactly.
 */
function resolveShopifyRedirectUri() {
  const explicit = String(process.env.SHOPIFY_REDIRECT_URI || '').trim();
  const base = String(process.env.SERVER_URL || 'https://api.topedgeai.com')
    .trim()
    .replace(/\/+$/, '');
  const candidate = explicit || `${base}/api/shopify/callback`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('redirect must be https or http');
    return u.toString();
  } catch (err) {
    const fb = `${base}/api/shopify/callback`;
    console.error('[ShopifyOAuth] Invalid SHOPIFY_REDIRECT_URI — using SERVER_URL fallback:', candidate, err.message);
    return fb;
  }
}

/**
 * Shopify requires redirect_uri on every /admin/oauth/authorize request.
 * Use URLSearchParams so scope commas / specials never break parsing (unencoded query caused "redirect_uri is missing").
 * Order: client_id → redirect_uri → state → scope (critical params before very long scope strings / proxy limits).
 */
function buildShopifyAuthorizeURL(shopHostname, { appClientId, scopes, state }) {
  const redirectUri = resolveShopifyRedirectUri();
  const cid = String(appClientId || '').trim();
  const sc = typeof scopes === 'string' ? scopes.trim() : '';
  if (!cid || !sc) throw new Error('Shopify OAuth: missing client_id or scopes');
  if (!redirectUri) throw new Error('Shopify OAuth: redirect_uri resolved empty — set SHOPIFY_REDIRECT_URI or SERVER_URL');

  const p = new URLSearchParams();
  p.set('client_id', cid);
  p.set('redirect_uri', redirectUri);
  if (state != null && String(state) !== '') p.set('state', String(state));
  p.set('scope', sc);

  const qs = p.toString();
  const authUrl = `https://${shopHostname}/admin/oauth/authorize?${qs}`;
  if (authUrl.length > 7500) {
    console.warn(
      `[ShopifyOAuth] OAuth URL is very long (${authUrl.length} chars). Consider shortening SHOPIFY_SCOPES — some proxies truncate.`
    );
  }
  return authUrl;
}

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'https://dash.topedgeai.com';

/** Relative frontend path only — prevents open redirects after OAuth. */
function sanitizeOAuthReturnTo(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const t = raw.trim();
  if (!t.startsWith('/') || t.startsWith('//') || /^https?:/i.test(t)) return '';
  return t.slice(0, 500);
}

function shopifyOAuthFrontendRedirect(pending, { success = false, errorCode = '' } = {}) {
  const frontendUrl = FRONTEND_URL().replace(/\/+$/, '');
  const returnTo = sanitizeOAuthReturnTo(pending?.returnTo);
  if (returnTo) {
    const u = new URL(returnTo, `${frontendUrl}/`);
    if (success) u.searchParams.set('shopify_connected', 'true');
    else if (errorCode) u.searchParams.set('shopify_error', errorCode);
    return `${u.pathname}${u.search}`;
  }
  if (success) return '/settings?tab=store&shopify_connected=true';
  if (errorCode) return `/settings?tab=store&shopify_error=${encodeURIComponent(errorCode)}`;
  return '/settings?tab=store';
}

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
const { SHOPIFY_WEBHOOK_TOPICS_WITH_SCOPES } = require('../constants/shopifyWebhookTopics');
const { expandImpliedScopes, parseShopifyScopes } = require('../utils/shopify/shopifyScopeUtils');

async function registerWebhooks(shopDomain, accessToken, clientId, grantedScopesStr) {
  const effectiveScopes = expandImpliedScopes(parseShopifyScopes(grantedScopesStr));
  const webhookUrl = `${process.env.SERVER_URL || 'https://api.topedgeai.com'}/api/shopify/webhook`;
  const results = [];

  for (const { topic, requiredScope } of SHOPIFY_WEBHOOK_TOPICS_WITH_SCOPES) {
    if (requiredScope && !effectiveScopes.includes(requiredScope)) {
      console.log(`ℹ️ [ShopifyOAuth] Skipped webhook ${topic} — missing scope ${requiredScope} for ${clientId}`);
      results.push({ topic, status: 'skipped_no_scope', requiredScope });
      continue;
    }
    try {
      await axios.post(
        `https://${shopDomain}/admin/api/${shopifyAdminApiVersion}/webhooks.json`,
        { webhook: { topic, address: webhookUrl, format: 'json' } },
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      console.log(`✅ [ShopifyOAuth] Registered webhook ${topic} for ${clientId}`);
      results.push({ topic, status: 'subscribed' });
    } catch (err) {
      if (err.response?.status === 422) {
        console.log(`ℹ️ [ShopifyOAuth] Webhook ${topic} already exists for ${clientId}`);
        results.push({ topic, status: 'already_exists' });
      } else {
        console.error(`❌ [ShopifyOAuth] Failed webhook ${topic} for ${clientId}:`, err.response?.data || err.message);
        results.push({ topic, status: 'failed', error: err.response?.data?.errors || err.message });
      }
    }
  }
  return results;
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
    invalidateClientCache(clientId);

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
    invalidateClientCache(clientId);

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
// STEP 1: POST /api/shopify/auth — Public / multi-store OAuth (no custom install link)
// Returns a direct Admin OAuth URL with one-time `state` (and sets cookie as fallback).
// Works for Shopify App Store + Partner "public" apps: any merchant store can install.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/auth', async (req, res) => {
  try {
    const { shopDomain, clientId, additionalStore, returnTo } = req.body;

    if (!shopDomain || !clientId) {
      return res.status(400).json({ success: false, error: 'Missing shopDomain or clientId' });
    }

    let cleanShop = shopDomain.replace(/https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    if (!cleanShop.includes('.myshopify.com')) {
      cleanShop = `${cleanShop}.myshopify.com`;
    }

    if (!isValidShopDomain(cleanShop)) {
      return res.status(400).json({ success: false, error: 'Invalid shop domain. Use your-store.myshopify.com' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const appClientId = SHOPIFY_CLIENT_ID();
    const appSecret = SHOPIFY_CLIENT_SECRET();
    if (!appClientId || !appSecret) {
      return res.status(500).json({ success: false, error: 'Shopify app credentials are not configured on the server.' });
    }

    const nonce = crypto.randomBytes(24).toString('hex');
    nonceStore.set(nonce, {
      clientId,
      shop: cleanShop,
      additionalStore: !!additionalStore,
      returnTo: sanitizeOAuthReturnTo(returnTo),
      createdAt: Date.now(),
    });

    const cookieSecret = appSecret || process.env.SHOPIFY_API_SECRET || 'fallback_cookie_secret';
    const signedClientId = signCookieValue(clientId, cookieSecret);

    res.cookie('shopify_oauth_client', signedClientId, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 10 * 60 * 1000
    });

    let authUrl;
    try {
      authUrl = buildShopifyAuthorizeURL(cleanShop, {
        appClientId,
        scopes: SHOPIFY_SCOPES(),
        state: nonce
      });
    } catch (e) {
      console.error('❌ [ShopifyOAuth] build authorize URL failed:', e.message);
      return res.status(500).json({ success: false, error: e.message || 'OAuth URL build failed — check SERVER_URL / SHOPIFY_REDIRECT_URI' });
    }

    console.log(`🔄 [ShopifyOAuth] OAuth URL built for clientId=${clientId} shop=${cleanShop} redirect_uri=${resolveShopifyRedirectUri()}`);

    return res.json({
      success: true,
      authUrl,
      shopifyInstallLink: client.shopifyInstallLink || null
    });

  } catch (error) {
    console.error('❌ [ShopifyOAuth] Auth initiation error:', error);
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

    const oauthClientId = SHOPIFY_CLIENT_ID();
    if (!oauthClientId || !SHOPIFY_CLIENT_SECRET()) {
      return res.status(500).send('Shopify OAuth is not configured.');
    }

    const nonce = crypto.randomBytes(24).toString('hex');
    nonceStore.set(nonce, {
      clientId: client ? client.clientId : null,
      shop,
      createdAt: Date.now()
    });

    let authUrl;
    try {
      authUrl = buildShopifyAuthorizeURL(shop, {
        appClientId: oauthClientId,
        scopes: SHOPIFY_SCOPES(),
        state: nonce
      });
    } catch (e) {
      console.error('❌ [ShopifyOAuth] app-load authorize URL:', e.message);
      return res.status(500).send('OAuth redirect configuration error.');
    }

    console.log(`🔄 [ShopifyOAuth] App-load authorize for shop=${shop}`);
    return res.redirect(302, authUrl);

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
    const { code, hmac, shop, state } = req.query;
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

    // ── 2b. Resolve workspace from OAuth `state` (preferred for public apps) ───
    let client = null;
    let oauthPending = null;
    if (state && typeof state === 'string') {
      if (state.endsWith(':SHOPIFY_INSTALL')) {
        const noncePart = state.slice(0, -(':SHOPIFY_INSTALL'.length));
        const pending = nonceStore.get(noncePart);
        if (pending) nonceStore.delete(noncePart);
        if (pending?.clientId === 'SHOPIFY_INSTALL') {
          client = await Client.findOne({
            $or: [{ shopDomain: shop }, { 'commerce.shopify.domain': shop }]
          });
          if (!client) {
            console.warn('[ShopifyOAuth] App Store install: no workspace linked to shop yet');
            return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=install_requires_account`);
          }
          console.log(`✅ [ShopifyOAuth] Client resolved via App Store flow: ${client.clientId}`);
        }
      } else {
        const pending = nonceStore.get(state);
        if (pending) {
          oauthPending = pending;
          nonceStore.delete(state);
          if (pending.clientId) {
            client = await Client.findOne({ clientId: pending.clientId });
            if (client && pending.shop && shop === pending.shop) {
              await Client.updateOne(
                { clientId: pending.clientId },
                { $set: { shopDomain: shop, 'commerce.shopify.domain': shop, storeType: 'shopify', 'commerce.storeType': 'shopify' } }
              );
            }
          }
          if (client) {
            console.log(`✅ [ShopifyOAuth] Client resolved via OAuth state: ${pending.clientId || 'cookie-fallback-next'}`);
          }
        }
      }
    }

    // ── 3. Session (Cookie) Verification + DB Fallback ───────────────────────────
    const cookieSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || 'fallback_cookie_secret';
    const rawCookie = getRawCookie(req, 'shopify_oauth_client');
    const clientIdFromCookie = verifyAndExtractCookie(rawCookie, cookieSecret);

    if (!client && clientIdFromCookie) {
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

    // ── 5. Token Exchange (expiring offline access token) ───────────────────────
    const {
      exchangeShopifyAuthorizationCode,
      shopifyTokenExpiryDate,
    } = require('../utils/shopify/shopifyOAuthTokenExchange');

    let tokenResponse;
    try {
      tokenResponse = {
        data: await exchangeShopifyAuthorizationCode(shop, {
          clientId: SHOPIFY_CLIENT_ID(),
          clientSecret,
          code,
        }),
      };
    } catch (tokenErr) {
      console.error('❌ [ShopifyOAuth] Token exchange failed:', tokenErr.response?.data || tokenErr.message);
      res.clearCookie('shopify_oauth_client');
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=token_exchange_failed`);
    }

    const { access_token, scope, refresh_token, expires_in } = tokenResponse.data;

    if (!access_token) {
      console.error('❌ [ShopifyOAuth] No access_token in Shopify response:', tokenResponse.data);
      res.clearCookie('shopify_oauth_client');
      return res.redirect(`${frontendUrl}/settings?tab=store&shopify_error=token_exchange_failed`);
    }

    console.log(`✅ [ShopifyOAuth] Access token received for ${clientId}. Scopes: ${scope}`);
    if (refresh_token) {
      console.log(`✅ [ShopifyOAuth] Expiring offline token with refresh support saved for ${clientId}`);
    } else {
      console.warn(`⚠️ [ShopifyOAuth] No refresh_token in token response for ${clientId} — merchant may need to reconnect if API calls fail`);
    }
    console.log(`✅ [ShopifyOAuth] Note: Shopify Billing API skipped. Client billed via Razorpay.`);

    // ── 6. Save to Database (multi-store MVP) ───────────────────────────────────
    const {
      ensureStoresFromLegacy,
      normalizeShopDomain,
      syncLegacyShopifyFields,
    } = require('../utils/shopify/shopifyStoreHelpers');

    const pendingMeta = oauthPending;

    const clientDoc = await Client.findOne({ clientId });
    ensureStoresFromLegacy(clientDoc);
    const normShop = normalizeShopDomain(shop);
    let stores = [...(clientDoc.shopifyStores || [])];
    const idx = stores.findIndex((s) => normalizeShopDomain(s.shopDomain) === normShop);
    const isAdditional =
      pendingMeta?.additionalStore ||
      (stores.length > 0 && idx < 0 && normalizeShopDomain(stores.find((s) => s.isPrimary)?.shopDomain) !== normShop);

    const storeEntry = {
      shopDomain: shop,
      accessToken: access_token,
      scopes: scope || '',
      connectedAt: new Date(),
      isPrimary: !isAdditional && (idx < 0 ? stores.length === 0 : stores[idx]?.isPrimary),
      label: idx >= 0 ? stores[idx].label : isAdditional ? `Store ${stores.length + 1}` : 'Primary store',
      status: 'connected',
    };

    if (idx >= 0) {
      stores[idx] = { ...stores[idx].toObject?.() || stores[idx], ...storeEntry };
    } else if (isAdditional) {
      storeEntry.isPrimary = false;
      stores.push(storeEntry);
    } else {
      stores = [storeEntry];
      storeEntry.isPrimary = true;
    }

    if (!isAdditional && stores.length > 1) {
      stores = stores.map((s) => ({
        ...s,
        isPrimary: normalizeShopDomain(s.shopDomain) === normShop,
      }));
    }

    clientDoc.shopifyStores = stores;
    syncLegacyShopifyFields(clientDoc);

    const updatePayload = {
      shopifyStores: stores,
      shopifyAccessToken: clientDoc.shopifyAccessToken,
      shopDomain: clientDoc.shopDomain,
      shopifyScopes: scope || '',
      shopifyRefreshToken: refresh_token || '',
      shopifyClientId: SHOPIFY_CLIENT_ID(),
      shopifyClientSecret: clientSecret,
      shopifyConnectionStatus: 'connected',
      lastShopifyError: '',
      shopifyTokenExpiresAt: shopifyTokenExpiryDate(expires_in),
      storeType: 'shopify',
      'commerce.shopify.domain': clientDoc.shopDomain || shop,
      'commerce.shopify.accessToken': clientDoc.shopifyAccessToken,
      'commerce.shopify.refreshToken': refresh_token || '',
      'commerce.shopify.clientId': SHOPIFY_CLIENT_ID(),
      'commerce.shopify.clientSecret': clientSecret,
      'commerce.storeType': 'shopify',
    };

    await Client.findOneAndUpdate({ clientId }, { $set: updatePayload }, { new: true });
    invalidateClientCache(clientId);

    try {
      const { ensurePixelWebhookSecret } = require('../utils/commerce/pixelWebhookSecret');
      await ensurePixelWebhookSecret(clientId);
    } catch (pixelSecretErr) {
      console.warn(`[ShopifyOAuth] pixelWebhookSecret: ${pixelSecretErr.message}`);
    }

    try {
      const { reconcileShopifyConnection } = require('../utils/shopify/shopifyConnectionHeal');
      await reconcileShopifyConnection(clientId, { tryRefresh: false });
    } catch (_) {}

    // Invalidate Redis connection-status cache so frontend immediately sees connected state
    try {
      const { getAppRedis, isRedisReady } = require('../utils/core/redisFactory');
      const redis = getAppRedis();
      if (redis && isRedisReady(redis)) {
        await redis.del(`workspace:connection:${clientId}`);
      }
    } catch (_) {}

    const { seedPlaybooksForClient } = require('../services/postPurchaseJourneys/seedPlaybooks');
    seedPlaybooksForClient(clientId).catch((e) =>
      console.warn(`[ShopifyOAuth] Playbook seed: ${e.message}`)
    );

    console.log(`✅ [ShopifyOAuth] Credentials saved for ${clientId}`);

    // Clear session cookie upon success
    res.clearCookie('shopify_oauth_client');

    // ── 7. Background Tasks ──────────────────────────────────────────────────────
    try {
      const webhookResults = await registerWebhooks(shop, access_token, clientId, scope);
      const subscribed = webhookResults.filter((r) => r.status === 'subscribed' || r.status === 'already_exists').length;
      console.log(`✅ [ShopifyOAuth] Webhooks: ${subscribed}/${webhookResults.length} subscribed for ${clientId}`);
    } catch (webhookErr) {
      console.error(`⚠️ [ShopifyOAuth] Webhook registration failed (non-fatal):`, webhookErr.message);
    }

    // Direct in-process sync (avoids self-call HTTP failures on containerized deploys)
    const { hasScopeEffective } = require('../utils/shopify/shopifyScopeUtils');
    const grantedScopes = scope || '';
    setImmediate(async () => {
      try {
        if (hasScopeEffective(grantedScopes, 'read_products')) {
          const { syncNicheDataProducts } = require('../utils/shopify/shopifyNicheProductSync');
          await syncNicheDataProducts(clientId);
          console.log(`✅ [ShopifyOAuth] Product sync complete for ${clientId}`);
        } else {
          console.log(`ℹ️ [ShopifyOAuth] Skipped product sync — read_products not granted for ${clientId}`);
        }
      } catch (e) {
        console.error(`⚠️ [ShopifyOAuth] Product sync failed for ${clientId}:`, e.message);
      }
      try {
        if (hasScopeEffective(grantedScopes, 'read_orders')) {
          const { syncShopifyOrdersToMongo } = require('../utils/shopify/shopifyOrderSync');
          const { getShopifyClient } = require('../utils/shopify/shopifyHelper');
          const shopClient = await getShopifyClient(clientId);
          const result = await syncShopifyOrdersToMongo(clientId, shopClient);
          console.log(`✅ [ShopifyOAuth] Order sync complete for ${clientId}: ${result.synced} synced, ${result.total} total`);
        } else {
          console.log(`ℹ️ [ShopifyOAuth] Skipped order sync — read_orders not granted for ${clientId}`);
        }
      } catch (e) {
        console.error(`⚠️ [ShopifyOAuth] Order sync failed for ${clientId}:`, e.message);
      }
    });

    console.log(`🎉 [ShopifyOAuth] OAuth complete for ${clientId}! Redirecting to frontend...`);
    const dest = shopifyOAuthFrontendRedirect(oauthPending, { success: true });
    return res.redirect(`${frontendUrl}${dest.startsWith('/') ? dest : `/${dest}`}`);

  } catch (error) {
    console.error('❌ [ShopifyOAuth] Callback error:', error.response?.data || error.message);
    res.clearCookie('shopify_oauth_client');
    const frontendUrl = FRONTEND_URL();
    const dest = shopifyOAuthFrontendRedirect(null, { errorCode: 'callback_failed' });
    return res.redirect(`${frontendUrl}${dest.startsWith('/') ? dest : `/${dest}`}`);
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
    if (!clientIdEnv) {
      return res.status(500).json({
        success: false,
        message: 'Shopify OAuth not configured.'
      });
    }

    let authUrl;
    try {
      authUrl = buildShopifyAuthorizeURL(cleanShop, {
        appClientId: clientIdEnv,
        scopes: SHOPIFY_SCOPES(),
        state
      });
    } catch (e) {
      console.error('[ShopifyOAuth] /install authorize URL:', e.message);
      return res.status(500).json({ success: false, message: 'OAuth redirect URL invalid — set SHOPIFY_REDIRECT_URI or SERVER_URL' });
    }

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
