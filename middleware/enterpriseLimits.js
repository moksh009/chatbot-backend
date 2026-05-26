const rateLimit = require('express-rate-limit');

const IS_DEV = process.env.NODE_ENV !== 'production';
const ENFORCE_IN_DEV = process.env.ENFORCE_API_RATE_LIMIT === 'true';

/**
 * Broad API protection for multi-tenant SaaS — skips webhooks and health checks.
 * Production: tune via API_RATE_LIMIT_MAX (requests per IP per minute).
 * Local dev: disabled by default (dashboards burst past 240/min easily).
 */
const apiGeneralLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: IS_DEV
    ? Math.max(5000, parseInt(process.env.API_RATE_LIMIT_MAX || '50000', 10) || 50000)
    : Math.min(600, Math.max(60, parseInt(process.env.API_RATE_LIMIT_MAX || '240', 10) || 240)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down and try again.' },
  skip: (req) => {
    if (IS_DEV && !ENFORCE_IN_DEV) return true;

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

module.exports = { apiGeneralLimiter, IS_DEV_API_LIMITS_OFF: IS_DEV && !ENFORCE_IN_DEV };
