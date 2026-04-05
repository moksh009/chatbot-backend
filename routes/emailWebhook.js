const express = require('express');
const router = express.Router();
const { handleIncomingEmail } = require('../utils/emailIntegration');
const log = require('../utils/logger')('EmailWebhook');

/**
 * @route POST /api/email/webhook
 * @desc Webhook endpoint for Resend inbound emails
 */
router.post('/webhook', async (req, res) => {
  log.info('Received Email Webhook from Resend');
  // Resend sends the email payload directly in the body for its "Inbound" configuration
  // The handleIncomingEmail utility already processes this and routes to DualBrainEngine
  await handleIncomingEmail(req, res);
});

module.exports = router;
