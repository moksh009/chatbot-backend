'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Per-IP + per-clientId rate limit for public third-party checkout webhooks.
 * Prevents abuse of `/api/webhooks/gokwik/:clientId` etc.
 */
const thirdPartyWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.THIRD_PARTY_WEBHOOK_RATE_MAX || '120', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const clientId = req.params?.clientId || 'unknown';
    return `tp_webhook:${clientId}:${ipKeyGenerator(req)}`;
  },
  message: { success: false, message: 'Webhook rate limit exceeded. Try again shortly.' },
});

module.exports = { thirdPartyWebhookLimiter };
