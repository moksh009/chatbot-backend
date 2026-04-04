const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Conversation = require('../models/Conversation');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
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
            for (const statusObj of value.statuses) {
              const { id: messageId, status, recipient_id: phone, errors } = statusObj;
              
              const updateData = { status };
              if (status === 'delivered') updateData.deliveredAt = new Date();
              if (status === 'read') updateData.readAt = new Date();
              if (status === 'failed') {
                updateData.failedAt = new Date();
                updateData.errorMessage = errors?.[0]?.message || 'Unknown error';
              }

              const msg = await CampaignMessage.findOneAndUpdate(
                { messageId },
                { $set: updateData },
                { new: true }
              );

              if (msg) {
                // Update Campaign aggregate stats
                const inc = {};
                if (status === 'delivered') inc.deliveredCount = 1;
                if (status === 'read') inc.readCount = 1;
                if (status === 'failed') inc.failedCount = 1;

                if (Object.keys(inc).length > 0) {
                  await Campaign.findByIdAndUpdate(msg.campaignId, { $inc: inc });
                }
              }
            }
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

              console.log(`📩 Incoming from ${from}:`, message.text?.body?.substring(0, 60) || message.type);

              // 2. Extract Meta Referral (Ad Attribution) — populated on click-to-WhatsApp ads
              if (message.referral) {
                message.referral = {
                  source_url:  message.referral.source_url,
                  source_type: message.referral.source_type, // 'ad' | 'post'
                  source_id:   message.referral.source_id,   // Facebook Ad ID
                  headline:    message.referral.headline,
                  body:        message.referral.body,
                  image_url:   message.referral.image_url,
                  video_url:   message.referral.video_url,
                };
                console.log(`🎯 [AdAttribution] Ad referral detected for ${from}:`, message.referral.headline || message.referral.source_id);
              }

              // 3. Mark message as replied-to in any open Campaign (for analytics)
              CampaignMessage.findOneAndUpdate(
                { phone: from, status: { $in: ['sent', 'delivered', 'read'] } },
                { $set: { repliedAt: new Date(), status: 'replied' } },
                { sort: { createdAt: -1 } }
              ).then(msg => {
                if (msg?.campaignId) {
                  Campaign.findByIdAndUpdate(msg.campaignId, { $inc: { repliedCount: 1 } }).catch(() => {});
                }
              }).catch(() => {});

              // B2. Handle WA Catalog Orders (message.type === 'order')
              if (message.type === 'order') {
                try {
                  const orderItems = message.order?.product_items || [];
                  console.log(`[MasterWebhook] 🛒 WA Catalog order from ${from}:`, orderItems.length, 'items');

                  const AdLead = require('../models/AdLead');
                  const lead = await AdLead.findOneAndUpdate(
                    { phoneNumber: from },
                    {
                      $set: {
                        cartStatus:      'whatsapp_order_placed',
                        lastInteraction: new Date(),
                        'cartSnapshot.items': orderItems.map(i => ({
                          variant_id: i.product_retailer_id,
                          quantity:   i.quantity
                        }))
                      },
                      $push: {
                        activityLog: {
                          action:    'whatsapp_catalog_order',
                          details:   `WA Catalog order: ${orderItems.length} item(s)`,
                          timestamp: new Date()
                        },
                        commerceEvents: {
                          event:     'whatsapp_order_placed',
                          amount:    0,
                          currency:  'INR',
                          timestamp: new Date(),
                          metadata:  { items: orderItems, catalogOrderId: message.id }
                        }
                      }
                    },
                    { new: true }
                  );

                  // Send acknowledgment
                  handleWhatsAppMessage(from, {
                    ...message,
                    type: 'text',
                    text: { body: `✅ Thank you! We've received your order for ${orderItems.length} item(s). Our team will confirm shortly.` },
                    _isCatalogAck: true
                  }, value.metadata?.phone_number_id, contact?.profile?.name || '')
                    .catch(() => {});

                  // Fire webhook event
                  try {
                    const { fireWebhookEvent } = require('../utils/webhookDelivery');
                    if (lead) {
                      const clientDoc = await require('../models/Client').findOne({ phoneNumberId: value.metadata?.phone_number_id });
                      if (clientDoc) fireWebhookEvent(clientDoc._id, 'order.created', { phone: from, items: orderItems, source: 'whatsapp_catalog' });
                    }
                  } catch (_) {}

                  // Emit socket event
                  if (global.io && lead) {
                    global.io.emit('whatsapp_order_received', { phone: from, items: orderItems });
                  }
                } catch (orderErr) {
                  console.error('[MasterWebhook] Catalog order error:', orderErr.message);
                }
                continue; // Don't process as regular message
              }

              // 4. Pass to processing engine (engine handles locking, lead upsert, flow execution)
              const contact = (value.contacts || []).find(c => c.wa_id === from);
              const profileName = contact?.profile?.name || '';
              
              handleWhatsAppMessage(from, message, value.metadata?.phone_number_id, profileName)
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
