const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { getPixelWebhookSecret } = require('../utils/commerce/pixelWebhookSecret');

/**
 * Rate limit extension/pixel webhook posts per client + IP.
 */
const pixelWebhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const clientId = req.params?.clientId || req.clientConfig?.clientId || 'unknown';
    return `shopify-ext-wh:${clientId}:${ipKeyGenerator(req.ip || 'unknown')}`;
  },
  message: { error: 'Too many pixel webhook requests' },
});

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Authenticate per-client Shopify extension / theme webhook posts.
 * Requires X-TopEdge-Pixel-Secret matching commerce.shopify.pixelWebhookSecret.
 */
async function verifyClientPixelWebhook(req, res, next) {
  try {
    const clientId = req.clientConfig?.clientId || req.params?.clientId;
    if (!clientId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const headerSecret =
      req.get('X-TopEdge-Pixel-Secret') ||
      req.get('x-topedge-pixel-secret') ||
      '';

    const stored = await getPixelWebhookSecret(clientId);
    if (!stored) {
      return res.status(401).json({ error: 'Pixel webhook secret not configured' });
    }

    if (!headerSecret || !timingSafeEqualStrings(headerSecret, stored)) {
      return res.status(401).json({ error: 'Invalid pixel webhook secret' });
    }

    return next();
  } catch (err) {
    console.error('[PixelWebhook] Auth error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = {
  verifyClientPixelWebhook,
  pixelWebhookRateLimiter,
};
