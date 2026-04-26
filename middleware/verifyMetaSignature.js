"use strict";

const crypto = require('crypto');

/**
 * Middleware: Verify Meta webhook signature (X-Hub-Signature-256)
 * Applied only to the IG automation webhook POST route.
 * Uses the raw request body (captured by express.json verify callback in index.js).
 */
function verifyMetaSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.error('[IG Webhook] Missing X-Hub-Signature-256 header');
    return res.sendStatus(403);
  }

  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.error('[IG Webhook] META_APP_SECRET not configured — cannot verify webhook signatures');
    return res.sendStatus(500);
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    console.error('[IG Webhook] rawBody not available — ensure express.json verify callback captures it');
    return res.sendStatus(500);
  }

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  try {
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      console.error('[IG Webhook] Invalid webhook signature — rejecting payload');
      return res.sendStatus(403);
    }
  } catch (err) {
    console.error('[IG Webhook] Signature comparison error:', err.message);
    return res.sendStatus(403);
  }

  next();
}

module.exports = verifyMetaSignature;
