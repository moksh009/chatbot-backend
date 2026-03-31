const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Conversation = require('../models/Conversation');
const { handleWhatsAppMessage } = require('../utils/dualBrainEngine');

/**
 * Middleware to verify Meta X-Hub-Signature-256
 */
const verifyMetaSignature = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.warn("⚠️ Meta Signature Missing");
    if (process.env.META_APP_SECRET) return res.status(401).send('Signature missing');
    return next();
  }

  const elements = signature.split('=');
  const signatureHash = elements[1];
  
  // Use req.rawBody if available for accurate HMAC verification
  const payload = req.rawBody ? req.rawBody : JSON.stringify(req.body);
  const expectedHash = crypto
    .createHmac('sha256', process.env.META_APP_SECRET || 'fallback_secret')
    .update(payload)
    .digest('hex');

  if (signatureHash !== expectedHash) {
    console.error("❌ Meta Signature Mismatch");
    return res.status(401).send('Signature mismatch');
  }
  next();
};

// 1. Webhook Verification (GET)
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const verifyToken = process.env.VERIFY_TOKEN || 'my_verify_token';

    if (mode && token === verifyToken) {
        console.log('✅ Webhook Root Verified');
        return res.status(200).send(challenge);
    }
    res.status(403).end();
});

// 2. Master Webhook Handling (POST)
router.post('/', verifyMetaSignature, async (req, res) => {
  const body = req.body;

  // Send 200 OK immediately as required by Meta to avoid retries
  res.status(200).send('EVENT_RECEIVED');

  if (body.object === 'whatsapp_business_account' && body.entry) {
    try {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          const value = change.value;
          
          // A. Handle Status Updates (delivered, read, failed)
          if (value.statuses) {
             // We can handle status updates here if needed for analytics
             // For now, logged for debugging
             // console.log("📉 Status Update:", JSON.stringify(value.statuses[0]));
          }

          // B. Handle Incoming Messages
          if (value.messages) {
            for (const message of value.messages) {
              const from = message.from; 
              const messageId = message.id;

              // 1. DEDUPLICATION CHECK
              const existingConvo = await Conversation.findOne({ 
                phone: from, 
                processedMessageIds: messageId 
              });
              
              if (existingConvo) {
                console.log(`♻️ Skipping duplicate message ${messageId} from ${from}`);
                continue; 
              }

              console.log(`📩 Incoming message from ${from}:`, message.text?.body || message.type);

              // Pass to processing engine
              // engine handles locking, conversation creation, and processing
              handleWhatsAppMessage(from, message, value.metadata?.phone_number_id)
                .catch(err => console.error("Engine Error:", err));
            }
          }
        }
      }
    } catch (err) {
      console.error('[MasterWebhook] Error processing webhook:', err.message);
    }
  }
});

module.exports = router;
