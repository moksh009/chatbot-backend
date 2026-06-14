const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const moment = require('moment');
const Client = require('../models/Client');
const PixelEvent = require('../models/PixelEvent');
const { protect } = require('../middleware/auth');
const { injectPixelScript, removePixelScript, verifyThemeHasPixelScript } = require('../utils/shopify/shopifyHelper');
const {
  processPixelEvent,
  generateWebPixelScript,
} = require('../utils/commerce/pixelEventProcessor');
const { buildTrackingHealth } = require('../utils/commerce/trackingHealth');
const {
  installWebPixel,
  getWebPixelInstallStatus,
} = require('../utils/shopify/pixelInstaller');
const {
  syncCheckoutConsentConfig,
  getCheckoutOptInInstallStatus,
} = require('../utils/shopify/checkoutConsentExtension');

/** Empty — bypass disabled so dashboard status + install reflect real web pixel registration. */
const PIXEL_STATUS_BYPASS_CLIENTS = new Set([]);

function shouldBypassShopifyPixelChecks(clientId) {
  return PIXEL_STATUS_BYPASS_CLIENTS.has(String(clientId || '').trim());
}

function assertPixelClientAccess(req, res, clientId) {
  if (req.user.clientId !== clientId && req.user.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function resolveBackendUrl(req) {
  return (
    process.env.BACKEND_URL ||
    process.env.SERVER_URL ||
    (process.env.NODE_ENV === 'production' ? 'https://api.topedgeai.com' : null) ||
    `${req.protocol}://${req.get('host')}`
  ).replace(/\/+$/, '');
}

const log = require('../utils/core/logger')('ShopifyPixel');

/** Storefront + checkout scripts call the API from merchant domains — allow cross-origin posts */
function pixelStorefrontCors(req, res, next) {
  const origin = req.headers.origin;
  // #region agent log
  log.info('[DEBUG-f2f95b] pixelStorefrontCors', {
    hypothesisId: 'H1',
    method: req.method,
    path: req.path,
    origin: origin || null,
  });
  fetch('http://127.0.0.1:7653/ingest/99fb88ce-bcb0-4691-9f80-8def3b29be3b', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'f2f95b' },
    body: JSON.stringify({
      sessionId: 'f2f95b',
      hypothesisId: 'H1',
      location: 'shopifyPixel.js:pixelStorefrontCors',
      message: 'storefront CORS handler',
      data: { method: req.method, path: req.path, origin: origin || null },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

async function markThemePixelInstalled(clientId) {
  await Client.updateOne(
    { clientId },
    {
      $set: {
        shopifyThemePixelInstalledAt: new Date(),
        shopifyTrackingDisabled: false,
      },
    }
  );
}

function buildScriptTag(clientId, backendUrl) {
  return `<script src="${backendUrl}/api/shopify-pixel/pixel/${clientId}/script.js" async></script>`;
}

const CHECKOUT_PIXEL_STEPS = [
  'Shopify Admin → Settings → Customer events.',
  'Click Add custom pixel → name it TopEdge.',
  'Paste the checkout pixel snippet below and Save.',
  'Visit checkout, enter email/phone, then refresh Website tracking.',
];

const VISITOR_COOKIE_MAX_AGE = 90 * 24 * 60 * 60;

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const part = raw.split(';').find((c) => c.trim().startsWith(`${name}=`));
  return part ? decodeURIComponent(part.split('=').slice(1).join('=').trim()) : '';
}

/**
 * First-party visitor id for identity stitching (storefront).
 * GET /api/shopify-pixel/pixel/:clientId/visitor-init
 */
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

const pixelRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const clientId = req.params?.clientId || 'unknown';
    const ip = ipKeyGenerator(req.ip || 'unknown');
    return `pixel:${clientId}:${ip}`;
  },
  message: { error: 'Too many pixel events from this IP, please try again after 15 minutes' },
});

router.options('/pixel/:clientId/visitor-init', pixelStorefrontCors);
router.get('/pixel/:clientId/visitor-init', pixelStorefrontCors, async (req, res) => {
  try {
    let visitorId = readCookie(req, 'te_visitor_id');
    if (!visitorId || !String(visitorId).startsWith('te_')) {
      visitorId = `te_${crypto.randomBytes(12).toString('hex')}`;
    }
    res.setHeader(
      'Set-Cookie',
      `te_visitor_id=${encodeURIComponent(visitorId)}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE}; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
    );
    // #region agent log
    log.info('[DEBUG-f2f95b] visitor-init ok', {
      hypothesisId: 'H2',
      clientId: req.params.clientId,
      origin: req.headers.origin || null,
      hasCookie: Boolean(readCookie(req, 'te_visitor_id')),
    });
    fetch('http://127.0.0.1:7653/ingest/99fb88ce-bcb0-4691-9f80-8def3b29be3b', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'f2f95b' },
      body: JSON.stringify({
        sessionId: 'f2f95b',
        hypothesisId: 'H2',
        location: 'shopifyPixel.js:visitor-init',
        message: 'visitor-init success',
        data: { clientId: req.params.clientId, origin: req.headers.origin || null },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    res.json({ success: true, visitorId });
  } catch (err) {
    // #region agent log
    log.error('[DEBUG-f2f95b] visitor-init failed', {
      hypothesisId: 'H2',
      clientId: req.params.clientId,
      error: err.message,
    });
    // #endregion
    res.status(500).json({ error: 'visitor_init_failed' });
  }
});

router.post('/pixel/:clientId', pixelStorefrontCors, pixelRateLimiter, async (req, res) => {
  try {
    const result = await processPixelEvent(req.params.clientId, {
      ...req.body,
      data: req.body.data || req.body.metadata || {},
      eventName: req.body.eventName || req.body.name,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    if (result.error) return res.status(404).json(result);
    res.status(200).json(result);
  } catch (err) {
    console.error('[DeepPixel] Error:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.options('/pixel/:clientId/event', pixelStorefrontCors);
router.options('/pixel/:clientId/script.js', pixelStorefrontCors);
router.post('/pixel/:clientId/event', pixelStorefrontCors, pixelRateLimiter, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { eventName, url, sessionId, metadata, shopifyClientId, visitorId, email, phone } =
      req.body;
    const eventData = {
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    };
    // #region agent log
    log.info('[DEBUG-f2f95b] pixel event received', {
      hypothesisId: 'H3',
      clientId,
      eventName: eventName || null,
      origin: req.headers.origin || null,
      hasEmail: Boolean(email || eventData.email),
      hasPhone: Boolean(phone || eventData.phone),
    });
    fetch('http://127.0.0.1:7653/ingest/99fb88ce-bcb0-4691-9f80-8def3b29be3b', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'f2f95b' },
      body: JSON.stringify({
        sessionId: 'f2f95b',
        hypothesisId: 'H3',
        location: 'shopifyPixel.js:event',
        message: 'pixel event POST',
        data: { clientId, eventName: eventName || null, origin: req.headers.origin || null },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const result = await processPixelEvent(req.params.clientId, {
      eventName,
      data: eventData,
      url,
      sessionId,
      visitorId: visitorId || readCookie(req, 'te_visitor_id'),
      shopifyClientId,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    if (clientId === 'delitech_smarthomes') {
      console.log(
        `[PixelEvent:${clientId}] event=${String(eventName || 'unknown')} status=${result?.status || 'ok'} leadId=${result?.leadId || 'none'}`
      );
    }
    if (result.error) return res.status(404).json(result);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pixel/:clientId/web-pixel-snippet', protect, async (req, res) => {
  const { clientId } = req.params;
  if (req.user.clientId !== clientId && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  const snippet = generateWebPixelScript(clientId, backendUrl);
  res.json({ success: true, snippet });
});

router.get('/pixel/:clientId/tracking-health', protect, async (req, res) => {
  const { clientId } = req.params;
  if (req.user.clientId !== clientId && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const periodDays = parseInt(req.query.periodDays || '30', 10);
  const health = await buildTrackingHealth(clientId, periodDays);
  res.json({ success: true, ...health });
});

router.get('/pixel/:clientId/script-tag', protect, async (req, res) => {
  const { clientId } = req.params;
  if (!assertPixelClientAccess(req, res, clientId)) return;
  const backendUrl = resolveBackendUrl(req);
  const scriptTag = `<script src="${backendUrl}/api/shopify-pixel/pixel/${clientId}/script.js" async></script>`;
  res.json({ success: true, backendUrl, scriptTag });
});

router.get('/pixel/:clientId/script.js', pixelStorefrontCors, async (req, res) => {
  const { clientId } = req.params;
  const backendUrl = resolveBackendUrl(req);

  const script = `
(function() {
    const CLIENT_ID = "${clientId}";
    const BACKEND_URL = "${backendUrl}";
    const SESSION_ID = localStorage.getItem("te_pixel_sid") || "sess_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("te_pixel_sid", SESSION_ID);

    var TE_VISITOR_ID = null;
    fetch(BACKEND_URL + "/api/shopify-pixel/pixel/" + CLIENT_ID + "/visitor-init", { credentials: "include" })
      .then(function(r) { return r.json(); })
      .then(function(j) { TE_VISITOR_ID = j.visitorId; })
      .catch(function() {});

    let debounceTimer;
    const TE_DEBOUNCE_MS = 300;

    function isThirdPartyCheckoutContext(el) {
        if (!el) return false;
        const classes = String(el.className || "").toLowerCase();
        const id = String(el.id || "").toLowerCase();
        const name = String(el.name || "").toLowerCase();
        const combined = classes + " " + id + " " + name;
        return /gokwik|razorpay|magic-checkout|shiprocket|fastrr|gk-/.test(combined);
    }

    function sendEvent(name, data = {}) {
        const payload = {
            eventName: name,
            url: window.location.href,
            sessionId: SESSION_ID,
            metadata: Object.assign({}, data, { source: "theme_pixel" }),
            timestamp: new Date().toISOString()
        };
        if (TE_VISITOR_ID) payload.visitorId = TE_VISITOR_ID;
        const persistedEmail = localStorage.getItem("te_pixel_email");
        const persistedPhone = localStorage.getItem("te_pixel_phone");
        if (persistedEmail) payload.email = persistedEmail;
        if (persistedPhone) payload.phone = persistedPhone;
        if (data.captureMode) payload.metadata.captureMode = data.captureMode;
        if (data.hasCartContext) payload.metadata.hasCartContext = true;
        if (window.Shopify) {
            payload.shopify = {
                shop: Shopify.shop,
                currency: Shopify.currency && Shopify.currency.active,
                theme: Shopify.theme && Shopify.theme.name
            };
        }
        fetch(BACKEND_URL + "/api/shopify-pixel/pixel/" + CLIENT_ID + "/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            keepalive: true,
            body: JSON.stringify(payload)
        }).catch(function() {});
    }

    sendEvent("page_view");

    if (window.Shopify && window.Shopify.checkout) {
        const eventName = window.location.pathname.includes("thank_you") ? "checkout_completed" : "checkout_started";
        sendEvent(eventName, {
            checkout: window.Shopify.checkout,
            total_price: window.Shopify.checkout.total_price || window.Shopify.checkout.totalPrice,
            currency: window.Shopify.checkout.currency
        });
    }

    function setupInterceptors() {
        document.addEventListener('click', function(e) {
            const el = e.target.closest('button, a, input[type="submit"]');
            if (!el) return;
            const text = (el.innerText || el.value || "").toLowerCase();
            const classes = el.className || "";
            const id = el.id || "";
            if (classes.includes('gokwik') || id.includes('gokwik') || text.includes('gokwik')) {
                sendEvent("checkout_started", { gateway: "gokwik", element: "button_click" });
            }
            if (classes.includes('razorpay') || text.includes('razorpay') || classes.includes('magic-checkout')) {
                sendEvent("checkout_started", { gateway: "razorpay", element: "button_click" });
            }
            if (classes.includes('shiprocket') || id.includes('shiprocket') || text.includes('shiprocket') || classes.includes('fastrr')) {
                sendEvent("checkout_started", { gateway: "shiprocket", element: "button_click" });
            }
            if (text === 'buy it now' || text === 'checkout') {
                sendEvent("checkout_started", { gateway: "native_or_generic", element: "button_click" });
            }
        }, true);
    }

    function setupMutationObserver() {
        const observer = new MutationObserver(function() {
            const inputs = document.querySelectorAll('input:not([data-te-tracked])');
            inputs.forEach(function(input) {
                const type = input.type;
                const name = (input.name || "").toLowerCase();
                const placeholder = (input.placeholder || "").toLowerCase();
                const parentCtx = isThirdPartyCheckoutContext(input);
                const isEmail = type === 'email' || name.includes('email') || placeholder.includes('email');
                const isPhone = type === 'tel' || name.includes('phone') || name.includes('mobile') || placeholder.includes('phone') || placeholder.includes('mobile') || name.includes('contact') || parentCtx;
                if (isEmail || isPhone) {
                    input.addEventListener('input', function(e) {
                        clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(function() {
                            const val = e.target.value.trim();
                            const hasCart = localStorage.getItem("te_pixel_has_cart") === "1";
                            if (isEmail && val.includes('@') && val.length > 5) {
                                localStorage.setItem("te_pixel_email", val);
                                sendEvent("contact_identified", {
                                    email: val,
                                    field: name || 'email',
                                    captureMode: "live_theme",
                                    hasCartContext: hasCart
                                });
                            } else if (isPhone) {
                                const clean = val.replace(/\\D/g, '');
                                if (clean.length >= 10) {
                                    localStorage.setItem("te_pixel_phone", clean);
                                    sendEvent("contact_identified", {
                                        phone: clean,
                                        field: name || 'phone',
                                        captureMode: "live_theme",
                                        hasCartContext: hasCart || parentCtx
                                    });
                                }
                            }
                        }, TE_DEBOUNCE_MS);
                    });
                    input.dataset.teTracked = "true";
                }
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    const originalFetch = window.fetch;
    window.fetch = function() {
        return originalFetch.apply(this, arguments).then(function(response) {
            const url = typeof arguments[0] === 'string' ? arguments[0] : arguments[0].url;
            if (url && (url.includes("/cart/add.js") || url.includes("/cart/add") || url.includes("/cart/update"))) {
                response.clone().json().then(function(data) {
                    localStorage.setItem("te_pixel_has_cart", "1");
                    sendEvent("product_added_to_cart", { product: data, hasCartContext: true });
                }).catch(function() {});
            }
            return response;
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            setupInterceptors();
            setupMutationObserver();
        });
    } else {
        setupInterceptors();
        setupMutationObserver();
    }
})();
  `.trim();

  res.set('Content-Type', 'application/javascript');
  return res.send(script);
});

router.post('/pixel/:clientId/inject', protect, async (req, res) => {
  const { clientId } = req.params;
  if (req.user.clientId !== clientId && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const backendUrl = resolveBackendUrl(req);
    const result = await injectPixelScript(clientId, backendUrl);
    if (result?.success) await markThemePixelInstalled(clientId);
    res.json({
      ...result,
      backendUrl,
      scriptTag: `<script src="${backendUrl}/api/shopify-pixel/pixel/${clientId}/script.js" async></script>`,
      nextStep: 'Visit your storefront once, then refresh status here.',
    });
  } catch (err) {
    console.error('[PixelInject] Error:', err.message);
    const isForbidden = err.response?.status === 403;
    let errorMsg = err.message;
    if (isForbidden) {
      errorMsg = 'Permission Denied: Ensure your Shopify App has write_themes and read_themes scopes.';
    } else if (err.response?.data?.errors) {
      errorMsg = `Shopify API Error: ${err.response.data.errors}`;
    }
    res.status(isForbidden ? 403 : 500).json({
      success: false,
      error: errorMsg,
      details: err.response?.data || null,
    });
  }
});

router.get('/pixel/:clientId/install-web-pixel/status', protect, async (req, res) => {
  const { clientId } = req.params;
  if (!assertPixelClientAccess(req, res, clientId)) return;
  const bypassShopifyChecks = shouldBypassShopifyPixelChecks(clientId);
  let themeScriptVerified = false;
  try {
    const verification = await verifyThemeHasPixelScript(clientId);
    themeScriptVerified = verification.found === true;
  } catch {
    themeScriptVerified = false;
  }
  if (bypassShopifyChecks) {
    return res.json({
      success: true,
      installed: themeScriptVerified,
      hasPixelScopes: true,
      reason: 'bypass_for_review',
      themeScriptVerified,
      requiresCheckoutPixel: true,
      message: themeScriptVerified
        ? 'Storefront theme script verified. Add the checkout custom pixel in Shopify Customer events.'
        : 'Bypass mode: theme script not found in theme.liquid — run one-click install or paste manually.',
      webPixelId: null,
    });
  }
  try {
    const registration = await getWebPixelInstallStatus(clientId);
    res.json({ success: true, themeScriptVerified, ...registration });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, code: err.code });
  }
});

router.post('/pixel/:clientId/install-web-pixel', protect, async (req, res) => {
  const { clientId } = req.params;
  if (!assertPixelClientAccess(req, res, clientId)) return;
  const backendUrl = resolveBackendUrl(req);
  const scriptTag = buildScriptTag(clientId, backendUrl);
  const checkoutPixelSnippet = generateWebPixelScript(clientId, backendUrl);

  if (shouldBypassShopifyPixelChecks(clientId)) {
    let themeInject = { success: false, message: 'Theme inject not attempted' };
    try {
      themeInject = await injectPixelScript(clientId, backendUrl);
      if (themeInject?.success) await markThemePixelInstalled(clientId);
    } catch (themeErr) {
      themeInject = { success: false, message: themeErr.message };
    }

    let themeScriptVerified = false;
    if (themeInject?.success) {
      try {
        const verification = await verifyThemeHasPixelScript(clientId);
        themeScriptVerified = verification.found === true;
      } catch {
        themeScriptVerified = false;
      }
    }

    if (!themeInject?.success) {
      return res.status(422).json({
        success: false,
        action: 'manual_required',
        bypassMode: true,
        themeInjected: false,
        themeScriptVerified: false,
        webPixelRegistered: false,
        requiresCheckoutPixel: true,
        scriptTag,
        checkoutPixelSnippet,
        checkoutPixelSteps: CHECKOUT_PIXEL_STEPS,
        backendUrl,
        message: `Theme auto-inject failed: ${themeInject.message}. Paste the theme script in theme.liquid, then add the checkout custom pixel.`,
        pollHint: 'After pasting both scripts, visit storefront + checkout and refresh status.',
      });
    }

    return res.json({
      success: true,
      action: 'bypass_theme_injected',
      bypassMode: true,
      themeInjected: true,
      themeScriptVerified,
      webPixelRegistered: false,
      requiresCheckoutPixel: true,
      scriptTag,
      checkoutPixelSnippet,
      checkoutPixelSteps: CHECKOUT_PIXEL_STEPS,
      backendUrl,
      message: themeScriptVerified
        ? 'Storefront script installed and verified. Add the checkout custom pixel in Shopify → Settings → Customer events.'
        : 'Storefront script injected — verification pending. Also add the checkout custom pixel in Customer events.',
      pollHint: 'Visit your storefront and checkout, then refresh status here.',
      manualSnippet: checkoutPixelSnippet,
    });
  }
  try {

    let themeInject = { success: false, message: 'Theme inject not attempted' };
    try {
      themeInject = await injectPixelScript(clientId, backendUrl);
      if (themeInject?.success) await markThemePixelInstalled(clientId);
    } catch (themeErr) {
      themeInject = { success: false, message: themeErr.message };
    }

    let webPixel = null;
    try {
      webPixel = await installWebPixel(clientId, { apiBaseUrl: backendUrl });
    } catch (webErr) {
      webPixel = {
        success: false,
        message: webErr.message,
        code: webErr.code,
        userErrors: webErr.userErrors,
      };
    }

    let consentSync = { success: false };
    try {
      consentSync = await syncCheckoutConsentConfig(clientId, backendUrl);
    } catch (syncErr) {
      consentSync = { success: false, message: syncErr.message };
    }

    const checkoutStatus = await getCheckoutOptInInstallStatus(clientId);

    const success = Boolean(themeInject?.success || webPixel?.success || consentSync?.success);
    if (!success) {
      return res.status(400).json({
        success: false,
        themeInjected: themeInject?.success === true,
        webPixel,
        consentSync,
        checkoutStatus,
        message:
          themeInject?.message ||
          webPixel?.message ||
          'Install failed. Paste the theme script manually or reconnect Shopify with write_themes + read_pixels + write_pixels + read_customer_events.',
      });
    }

    const checkboxMessage = checkoutStatus.extensionDeployed
      ? 'Next: open Checkout Editor and add the “TopEdge WhatsApp opt-in” app block on the Contact step, then publish.'
      : 'Tracking registered. Deploy TopEdge app extensions (shopify app deploy) so the checkout checkbox can appear.';

    res.json({
      success: true,
      action: webPixel?.action || (themeInject?.success ? 'theme_injected' : 'unknown'),
      themeInjected: themeInject?.success === true,
      webPixelRegistered: webPixel?.success === true,
      webPixelId: webPixel?.webPixelId || null,
      consentConfigSynced: consentSync?.success === true,
      checkoutStatus,
      checkoutEditorUrl: checkoutStatus.checkoutCustomizeUrl || checkoutStatus.checkoutEditorUrl,
      scriptTag: buildScriptTag(clientId, backendUrl),
      checkoutPixelSnippet: webPixel?.success ? null : checkoutPixelSnippet,
      checkoutPixelSteps: webPixel?.success ? null : CHECKOUT_PIXEL_STEPS,
      backendUrl,
      message: themeInject?.success
        ? `Storefront script added. ${checkboxMessage}`
        : webPixel?.pollHint || checkboxMessage,
      pollHint: checkoutStatus.statusHint,
      manualSnippet: webPixel?.manualSnippet || checkoutPixelSnippet,
    });
  } catch (err) {
    const status = /not_connected|missing_pixel_scopes/i.test(err.message) ? 400 : 500;
    res.status(status).json({
      success: false,
      error: err.message,
      code: err.code,
      userErrors: err.userErrors || undefined,
    });
  }
});

router.get('/pixel/:clientId/checkout-opt-in/status', protect, async (req, res) => {
  const { clientId } = req.params;
  if (!assertPixelClientAccess(req, res, clientId)) return;
  try {
    const checkoutStatus = await getCheckoutOptInInstallStatus(clientId);
    res.json({ success: true, ...checkoutStatus });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/pixel/:clientId/checkout-opt-in/sync', protect, async (req, res) => {
  const { clientId } = req.params;
  if (!assertPixelClientAccess(req, res, clientId)) return;
  try {
    const backendUrl = resolveBackendUrl(req);
    const result = await syncCheckoutConsentConfig(clientId, backendUrl);
    const checkoutStatus = await getCheckoutOptInInstallStatus(clientId);
    res.json({ success: true, ...result, checkoutStatus });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function buildPixelStatusPayload(clientId, req) {
  const backendUrl = resolveBackendUrl(req);
  const scriptTag = buildScriptTag(clientId, backendUrl);
  const checkoutPixelSnippet = generateWebPixelScript(clientId, backendUrl);
  const bypassShopifyChecks = shouldBypassShopifyPixelChecks(clientId);

  const clientDoc = await Client.findOne({ clientId })
    .select(
      'shopifyThemePixelInstalledAt shopifyWebPixelId shopifyWebPixelInstalledAt shopDomain shopifyTrackingDisabled'
    )
    .lean();

  if (clientDoc?.shopifyTrackingDisabled) {
    return {
      success: true,
      connectionState: 'not_connected',
      isInstalled: false,
      isActive: false,
      eventsLive: false,
      trackingDisabled: true,
      themeInjected: false,
      themeScriptVerified: false,
      webPixelRegistered: false,
      webPixelOnShopify: false,
      bypassMode: bypassShopifyChecks,
      requiresCheckoutPixel: bypassShopifyChecks,
      eventsPerMinute: 0,
      lastEventAt: null,
      lastEventName: null,
      totalEvents: 0,
      eventBreakdown: [],
      recentEvents: [],
      anonymousActivity: [],
      backendUrl,
      scriptTag,
      checkoutPixelSnippet,
      checkoutPixelSteps: CHECKOUT_PIXEL_STEPS,
      shopDomain: clientDoc?.shopDomain || null,
      statusHint: 'Tracking disconnected. Click one-click install to reconnect storefront + checkout capture.',
    };
  }

  const fiveMinutesAgo = moment().subtract(5, 'minutes').toDate();
  const fifteenMinutesAgo = moment().subtract(15, 'minutes').toDate();
  const thirtyDaysAgo = moment().subtract(30, 'days').toDate();
  const sevenDaysAgo = moment().subtract(7, 'days').toDate();

  const [count, lastEvent, eventBreakdown, recentEvents, anonymousCartEvents] = await Promise.all([
    PixelEvent.countDocuments({
      clientId,
      timestamp: { $gte: fiveMinutesAgo },
    }),
    PixelEvent.findOne({ clientId }).sort({ timestamp: -1 }).lean(),
    PixelEvent.aggregate([
      { $match: { clientId, timestamp: { $gte: thirtyDaysAgo } } },
      { $group: { _id: '$eventName', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 24 },
    ]),
    PixelEvent.find({ clientId })
      .sort({ timestamp: -1 })
      .limit(12)
      .select('eventName timestamp url metadata sessionId')
      .lean(),
    PixelEvent.find({
      clientId,
      leadId: null,
      eventName: {
        $in: [
          'page_view',
          'product_added_to_cart',
          'checkout_started',
          'contact_identified',
          'checkout_contact_identified',
        ],
      },
      timestamp: { $gte: sevenDaysAgo },
    })
      .sort({ timestamp: -1 })
      .limit(40)
      .select('eventName timestamp url sessionId metadata')
      .lean(),
  ]);

  const eventsPerMinute = parseFloat((count / 5).toFixed(1));
  const eventsLive =
    (lastEvent && moment(lastEvent.timestamp).isAfter(fifteenMinutesAgo)) || false;
  const themeMarkedInstalled = Boolean(clientDoc?.shopifyThemePixelInstalledAt);
  const webPixelRegistered = Boolean(
    clientDoc?.shopifyWebPixelId || clientDoc?.shopifyWebPixelInstalledAt
  );

  let themeScriptVerified = false;
  let themeVerifyError = null;
  try {
    const verification = await verifyThemeHasPixelScript(clientId);
    themeScriptVerified = verification.found === true;
    if (!themeScriptVerified && verification.error) themeVerifyError = verification.error;
  } catch (verifyErr) {
    themeVerifyError = verifyErr.message;
  }

  let webPixelApi = null;
  if (bypassShopifyChecks) {
    webPixelApi = {
      installed: false,
      hasPixelScopes: true,
      reason: 'bypass_for_review',
      requiresCheckoutPixel: true,
      message:
        'App review bypass: use the checkout custom pixel snippet below until webPixelCreate is approved.',
    };
  } else {
    try {
      webPixelApi = await getWebPixelInstallStatus(clientId);
    } catch {
      webPixelApi = null;
    }
  }

  const webPixelOnShopify = webPixelApi?.installed === true;
  const webPixelScopeMissing =
    webPixelApi?.reason === 'missing_pixel_scopes' && webPixelApi?.hasPixelScopes === false;
  const requiresCheckoutPixel = bypassShopifyChecks || (!webPixelOnShopify && !webPixelRegistered);
  const themeActuallyReady = themeScriptVerified || eventsLive;
  const isInstalled =
    !webPixelScopeMissing &&
    (themeActuallyReady || webPixelOnShopify || webPixelRegistered);
  const connectionState = eventsLive
    ? 'live'
    : isInstalled
      ? 'connected'
      : 'not_connected';

  const health = await buildTrackingHealth(clientId, 30).catch(() => null);

  let checkoutStatus = null;
  if (!bypassShopifyChecks) {
    try {
      checkoutStatus = await getCheckoutOptInInstallStatus(clientId);
    } catch {
      checkoutStatus = null;
    }
  }

  const sessionsMap = new Map();
  for (const ev of anonymousCartEvents) {
    const sid = ev.sessionId || ev.metadata?.visitorId || 'unknown';
    if (!sessionsMap.has(sid)) {
      sessionsMap.set(sid, {
        sessionId: sid,
        lastEventAt: ev.timestamp,
        lastEventName: ev.eventName,
        lastUrl: ev.url || null,
        hasCart: false,
        hasContact: false,
        eventCount: 0,
      });
    }
    const session = sessionsMap.get(sid);
    session.eventCount += 1;
    if (moment(ev.timestamp).isAfter(session.lastEventAt)) {
      session.lastEventAt = ev.timestamp;
      session.lastEventName = ev.eventName;
      session.lastUrl = ev.url || session.lastUrl;
    }
    if (ev.eventName === 'product_added_to_cart') session.hasCart = true;
    if (['contact_identified', 'checkout_contact_identified'].includes(ev.eventName)) {
      session.hasContact = true;
    }
  }
  const anonymousActivity = Array.from(sessionsMap.values()).slice(0, 8);

  let storefrontHint;
  if (webPixelScopeMissing) {
    storefrontHint =
      'Store token is missing pixel scopes (read_pixels/write_pixels/read_customer_events). Reconnect Shopify from Settings before tracking can work.';
  } else if (themeMarkedInstalled && !themeScriptVerified && !eventsLive) {
    storefrontHint =
      'Theme script not found in theme.liquid — run one-click install again or paste the script tag manually.';
  } else if (requiresCheckoutPixel && themeActuallyReady && !eventsLive) {
    storefrontHint =
      'Storefront script ready. Add the checkout custom pixel in Shopify → Settings → Customer events to capture checkout email/phone.';
  } else if (bypassShopifyChecks && !themeActuallyReady) {
    storefrontHint =
      'Bypass mode: install the theme script and checkout custom pixel to start receiving signals.';
  } else if (eventsLive) {
    storefrontHint = 'Receiving storefront signals.';
  } else if (isInstalled) {
    storefrontHint =
      'Tracking is connected — visit your storefront to confirm live signals (page views appear within seconds).';
  } else {
    storefrontHint =
      checkoutStatus?.statusHint ||
      'Install tracking, then add the checkout custom pixel in Shopify Customer events.';
  }

  return {
    success: true,
    connectionState,
    isInstalled,
    isActive: eventsLive,
    eventsLive,
    trackingDisabled: false,
    themeInjected: themeMarkedInstalled,
    themeScriptVerified,
    themeVerifyError,
    webPixelActive: eventsLive,
    webPixelRegistered: !webPixelScopeMissing && (webPixelRegistered || webPixelOnShopify),
    webPixelOnShopify,
    webPixelScopeMissing,
    webPixelScopeMessage: webPixelApi?.message || null,
    bypassMode: bypassShopifyChecks,
    requiresCheckoutPixel,
    checkoutPixelSnippet,
    checkoutPixelSteps: CHECKOUT_PIXEL_STEPS,
    webPixelId: clientDoc?.shopifyWebPixelId || webPixelApi?.webPixelId || null,
    lastWebPixelEventAt: lastEvent?.timestamp || null,
    eventsPerMinute,
    lastEventAt: lastEvent ? lastEvent.timestamp : null,
    lastEventName: lastEvent?.eventName || null,
    totalEvents: count,
    eventBreakdown: eventBreakdown.map((row) => ({
      eventName: row._id,
      count: row.count,
    })),
    recentEvents: recentEvents.map((ev) => ({
      eventName: ev.eventName,
      timestamp: ev.timestamp,
      url: ev.url || null,
      source: ev.metadata?.source || ev.metadata?.gateway || null,
    })),
    anonymousActivity,
    captureSource: 'theme_script',
    backendUrl,
    scriptTag,
    shopDomain: clientDoc?.shopDomain || null,
    trackingHealth: health,
    checkoutStatus,
    statusHint: storefrontHint,
  };
}

router.post('/pixel/:clientId/disconnect-tracking', protect, async (req, res) => {
  const { clientId } = req.params;
  if (!assertPixelClientAccess(req, res, clientId)) return;
  try {
    const backendUrl = resolveBackendUrl(req);
    let themeRemoval = { success: true, removed: false };
    try {
      themeRemoval = await removePixelScript(clientId, backendUrl);
    } catch (themeErr) {
      themeRemoval = { success: false, message: themeErr.message };
    }

    await Client.updateOne(
      { clientId },
      {
        $unset: {
          shopifyThemePixelInstalledAt: '',
          shopifyWebPixelId: '',
          shopifyWebPixelInstalledAt: '',
          shopifyWebPixelSettings: '',
        },
        $set: {
          shopifyTrackingDisabled: true,
        },
      }
    );

    res.json({
      success: true,
      themeRemoval,
      message:
        'Tracking disconnected in TopEdge. Remove the custom web pixel in Shopify → Settings → Customer events if you no longer want checkout capture.',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/pixel/:clientId/status', protect, async (req, res) => {
  const { clientId } = req.params;
  if (!assertPixelClientAccess(req, res, clientId)) return;
  try {
    const payload = await buildPixelStatusPayload(clientId, req);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
