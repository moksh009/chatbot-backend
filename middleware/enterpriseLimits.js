const rateLimit = require('express-rate-limit');

/**
 * Broad API protection for multi-tenant SaaS — skips webhooks and health checks.
 * Tune via API_RATE_LIMIT_MAX (requests per IP per minute).
 */
const apiGeneralLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Math.min(600, Math.max(60, parseInt(process.env.API_RATE_LIMIT_MAX || '240', 10) || 240)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down and try again.' },
  skip: (req) => {
    const path = req.path || '';
    if (path === '/health' || path.startsWith('/metrics')) return true;
    if (path.includes('/webhook')) return true;
    if (path.startsWith('/ig-automation/webhook')) return true;
    if (path.startsWith('/razorpay')) return true;
    if (path.startsWith('/email/webhook')) return true;
    if (path.startsWith('/shopify-pixel')) return true;
    return false;
  },
});

module.exports = { apiGeneralLimiter };
