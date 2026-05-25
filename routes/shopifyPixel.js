const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const moment = require('moment');
const PixelEvent = require('../models/PixelEvent');
const { protect } = require('../middleware/auth');
const { injectPixelScript } = require('../utils/shopify/shopifyHelper');
const {
  processPixelEvent,
  generateWebPixelScript,
} = require('../utils/commerce/pixelEventProcessor');
const { buildTrackingHealth } = require('../utils/commerce/trackingHealth');
const {
  installWebPixel,
  getWebPixelInstallStatus,
} = require('../utils/shopify/pixelInstaller');

function assertPixelClientAccess(req, res, clientId) {
  if (req.user.clientId !== clientId && req.user.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

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
router.get('/pixel/:clientId/visitor-init', async (req, res) => {
  let visitorId = readCookie(req, 'te_visitor_id');
  if (!visitorId || !String(visitorId).startsWith('te_')) {
    visitorId = `te_${crypto.randomBytes(12).toString('hex')}`;
  }
  res.setHeader(
    'Set-Cookie',
    `te_visitor_id=${encodeURIComponent(visitorId)}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE}; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
  );
  res.json({ success: true, visitorId });
});

router.post('/pixel/:clientId', async (req, res) => {
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

router.post('/pixel/:clientId/event', async (req, res) => {
  try {
    const { eventName, url, sessionId, metadata, shopifyClientId, visitorId } = req.body;
    const result = await processPixelEvent(req.params.clientId, {
      eventName,
      data: metadata || {},
      url,
      sessionId,
      visitorId: visitorId || readCookie(req, 'te_visitor_id'),
      shopifyClientId,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
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

router.get('/pixel/:clientId/script.js', async (req, res) => {
  const { clientId } = req.params;
  const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;

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
            if (classes.includes('razorpay') || text.includes('razorpay')) {
                sendEvent("checkout_started", { gateway: "razorpay", element: "button_click" });
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
                const isEmail = type === 'email' || name.includes('email') || placeholder.includes('email');
                const isPhone = type === 'tel' || name.includes('phone') || name.includes('mobile') || placeholder.includes('phone') || placeholder.includes('mobile') || name.includes('contact');
                if (isEmail || isPhone) {
                    input.addEventListener('input', function(e) {
                        clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(function() {
                            const val = e.target.value.trim();
                            if (isEmail && val.includes('@') && val.length > 5) {
                                localStorage.setItem("te_pixel_email", val);
                                sendEvent("contact_identified", { email: val, field: name || 'email' });
                            } else if (isPhone) {
                                const clean = val.replace(/\\D/g, '');
                                if (clean.length >= 10) {
                                    localStorage.setItem("te_pixel_phone", clean);
                                    sendEvent("contact_identified", { phone: clean, field: name || 'phone' });
                                }
                            }
                        }, 1000);
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
                    sendEvent("product_added_to_cart", { product: data });
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
    const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
    const result = await injectPixelScript(clientId, backendUrl);
    res.json(result);
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
  try {
    const registration = await getWebPixelInstallStatus(clientId);
    res.json({ success: true, ...registration });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, code: err.code });
  }
});

router.post('/pixel/:clientId/install-web-pixel', protect, async (req, res) => {
  const { clientId } = req.params;
  if (!assertPixelClientAccess(req, res, clientId)) return;
  try {
    const backendUrl =
      process.env.BACKEND_URL ||
      process.env.SERVER_URL ||
      `${req.protocol}://${req.get('host')}`;
    const result = await installWebPixel(clientId, { apiBaseUrl: backendUrl });
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
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

router.get('/pixel/:clientId/status', protect, async (req, res) => {
  const { clientId } = req.params;
  if (!assertPixelClientAccess(req, res, clientId)) return;
  try {
    const fiveMinutesAgo = moment().subtract(5, 'minutes').toDate();
    const fifteenMinutesAgo = moment().subtract(15, 'minutes').toDate();
    const count = await PixelEvent.countDocuments({
      clientId,
      timestamp: { $gte: fiveMinutesAgo },
    });
    const lastEvent = await PixelEvent.findOne({ clientId }).sort({ timestamp: -1 });
    const eventsPerMinute = (count / 5).toFixed(1);
    const isActive =
      (lastEvent && moment(lastEvent.timestamp).isAfter(fifteenMinutesAgo)) || false;
    const themeRecent =
      lastEvent && moment(lastEvent.timestamp).isAfter(moment().subtract(24, 'hours'));
    const { buildTrackingHealth } = require('../utils/commerce/trackingHealth');
    const health = await buildTrackingHealth(clientId, 1).catch(() => null);
    const storefrontActive = !!health?.storefrontActive;
    res.json({
      success: true,
      isActive,
      /** Theme-script pixel (single story — no Shopify Web Pixel Admin API) */
      webPixelActive: isActive,
      webPixelRegistered: storefrontActive || themeRecent,
      webPixelScopeMissing: false,
      webPixelScopeMessage: null,
      webPixelId: null,
      lastWebPixelEventAt: lastEvent?.timestamp || null,
      eventsPerMinute: parseFloat(eventsPerMinute),
      lastEventAt: lastEvent ? lastEvent.timestamp : null,
      totalEvents: count,
      captureSource: 'theme_script',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
