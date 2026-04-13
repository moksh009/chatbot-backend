const express = require('express');
const router = express.Router();
const WebhookController = require('../controllers/WebhookController');
const { verifyMetaSignature } = require('../middleware/MetaAuthMiddleware');

// Meta Webhook Entry Point
// verifyMetaSignature ensures the payload is signed by Meta
router.post('/meta', verifyMetaSignature, WebhookController.handleWhatsAppWebhook);

module.exports = router;
