'use strict';

/** Marks a route as intentionally public (no tenant scope / role enforcement). */
function publicRoute() {
  const fn = (req, res, next) => {
    req.isPublicRoute = true;
    next();
  };
  fn.isPublicRoute = true;
  return fn;
}

const PUBLIC_PREFIXES = [
  '/api/auth',
  '/api/public',
  '/api/shopify/webhook',
  '/api/shopify/compliance',
  '/api/razorpay',
  '/api/email/webhook',
  '/api/ig-automation/webhook',
  '/whatsapp-webhook',
  '/api/_dev/webhook-test',
  '/keepalive',
  '/homepage',
  '/r/',
];

function isPublicApiPath(url) {
  const p = String(url || '').split('?')[0];
  return PUBLIC_PREFIXES.some((prefix) => p.startsWith(prefix));
}

module.exports = { publicRoute, isPublicApiPath };
