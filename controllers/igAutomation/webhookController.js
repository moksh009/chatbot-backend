"use strict";

const express = require('express');
const router = express.Router();
const verifyMetaSignature = require('../../middleware/verifyMetaSignature');
const { processIGWebhookPayload } = require('../../utils/igWebhookProcessor');
const log = require('../../utils/logger')('IGWebhook');

/**
 * GET /api/ig-automation/webhook
 * Meta webhook verification handshake — responds with hub.challenge.
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = process.env.IG_WEBHOOK_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN;
  if (mode === 'subscribe' && token === expectedToken) {
    log.info('[Webhook] Verification handshake successful');
    return res.status(200).send(challenge);
  }

  log.warn('[Webhook] Verification failed — invalid mode or token');
  return res.sendStatus(403);
});

/**
 * POST /api/ig-automation/webhook
 * Receives Instagram webhook events. Responds with 200 immediately,
 * then processes the payload asynchronously.
 * Meta retries if no 200 response within 5 seconds.
 */
router.post('/webhook', verifyMetaSignature, async (req, res) => {
  // Acknowledge immediately — Meta requires 200 within 5 seconds
  res.sendStatus(200);

  // Process asynchronously — never await inside the route handler
  processIGWebhookPayload(req.body).catch(async (err) => {
    log.error('[Webhook] Processing error:', err.message);
    try {
      const WebhookErrorLog = require('../../models/WebhookErrorLog');
      await WebhookErrorLog.create({
        payload: req.body,
        error: err.message,
        stack: err.stack
      });
    } catch (logErr) {
      log.error('[Webhook] Failed to save error log:', logErr.message);
    }
  });
});

module.exports = router;
