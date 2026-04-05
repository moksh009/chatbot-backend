/**
 * Security Sanitization Layer
 * Used to strip sensitive credentials and tokens from objects before
 * sending them to the frontend or external APIs.
 */

const SENSITIVE_FIELDS = [
  'whatsappToken',
  'whatsapp_access_token',
  'verifyToken',
  'geminiApiKey',
  'openaiApiKey',
  'emailAppPassword',
  'razorpayKeyId',
  'razorpaySecret',
  'shopifyAccessToken',
  'shopifyRefreshToken',
  'shopifyWebhookSecret',
  'shopifyClientId',
  'shopifyClientSecret',
  'cashfreeAppId',
  'cashfreeSecretKey',
  'woocommerceKey',
  'woocommerceSecret',
  'woocommerceWebhookSecret',
  'instagramAccessToken',
  'instagramAppSecret',
  'instagramPendingToken',
  'metaAdsAccessToken',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'password',
  'token'
];

/**
 * Recursively removes sensitive fields from an object or array.
 * @param {Object|Array} data - The data to sanitize.
 * @returns {Object|Array} The sanitized data.
 */
function sanitize(data) {
  if (data === null || data === undefined) return data;

  // Handle Mongoose documents
  let target = data;
  if (typeof data.toObject === 'function') {
    target = data.toObject();
  }

  if (Array.isArray(target)) {
    return target.map(item => sanitize(item));
  }

  if (typeof target !== 'object') {
    return target;
  }

  const sanitized = {};

  for (let [key, value] of Object.entries(target)) {
    // Check if key is sensitive (case-insensitive check)
    const isSensitive = SENSITIVE_FIELDS.some(field => 
      key.toLowerCase().includes(field.toLowerCase())
    );

    if (isSensitive) {
      // Sensitive field: Replace with masked string instead of dropping
      // to avoid breaking frontend logic that checks for existence.
      sanitized[key] = '••••••••';
      continue;
    }

    if (value && typeof value === 'object') {
      sanitized[key] = sanitize(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Express Middleware to sanitize outgoing JSON responses.
 * Usage: router.get('/path', protect, sanitizeMiddleware, (req, res) => { ... });
 */
function sanitizeMiddleware(req, res, next) {
  const originalJson = res.json;
  res.json = function(data) {
    return originalJson.call(this, sanitize(data));
  };
  next();
}

module.exports = { sanitize, sanitizeMiddleware, SENSITIVE_FIELDS };
