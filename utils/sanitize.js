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
  'secret',
  'apiKey',
  'password'
];

/**
 * Recursively removes sensitive fields from an object or array.
 * @param {Object|Array} data - The data to sanitize.
 * @param {number} depth - Recursion depth tracker.
 * @returns {Object|Array} The sanitized data.
 */
function sanitize(data, depth = 0) {
  // Prevent infinite recursion on circular structures or excessively deep objects
  if (depth > 10) return '[Max Depth Reached]';
  
  if (data === null || data === undefined) return data;

  // Handle Mongoose documents or objects with toObject (convert to POJO)
  let target = data;
  if (typeof data.toObject === 'function') {
    try {
      target = data.toObject();
    } catch (e) {
      console.error('[Sanitize] toObject conversion failed:', e.message);
      return '[Error: Serialization Failed]';
    }
  }

  // Handle arrays
  if (Array.isArray(target)) {
    return target.map(item => sanitize(item, depth + 1));
  }

  // If not an object (primitive), return as is
  if (target === null || typeof target !== 'object') {
    return target;
  }

  // Avoid processing Buffer, Date, or other specialized objects as generic POJOs
  if (target instanceof Date || target instanceof RegExp) {
    return target;
  }

  const sanitized = {};

  try {
    for (const [key, value] of Object.entries(target)) {
      // Check if key is sensitive (case-insensitive check)
      const isSensitive = SENSITIVE_FIELDS.some(field => 
        key.toLowerCase().includes(field.toLowerCase())
      );

      if (isSensitive) {
        // Replace sensitive fields with masking instead of dropping
        sanitized[key] = '••••••••';
        continue;
      }

      // Recursively sanitize nested objects/arrays
      if (value && typeof value === 'object') {
        sanitized[key] = sanitize(value, depth + 1);
      } else {
        sanitized[key] = value;
      }
    }
  } catch (err) {
    console.error('[Sanitize] Critical error during object traversal:', err.message);
    return '[Error: Traversal Failed]';
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
