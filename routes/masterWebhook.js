const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const log = require('../utils/logger')('MasterWebhook');
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
    log.warn("Meta Signature Missing");
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
    log.error("Meta Signature Mismatch");
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
        log.info('Webhook Root Verified');
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
    // Process entries asynchronously to avoid blocking the event loop
    processWebhookEntries(body.entry).catch(err => log.error('Async processing failed', { error: err.message }));
  }
});

/**
 * High-performance async processor for webhook entries.
 * Decouples HTTP response from business logic.
 */
async function processWebhookEntries(entries) {
  for (const entry of entries) {
    for (const change of entry.changes) {
      const value = change.value;
      if (!value) continue;

      // A. Handle Status Updates (delivered, read, failed)
      if (value.statuses) {
        processStatuses(value.statuses).catch(e => log.error('Status processing failure', { error: e.message }));
      }

      // B. Handle Incoming Messages
      if (value.messages) {
        processMessages(value.messages, value.metadata, value.contacts).catch(e => log.error('Message processing failure', { error: e.message }));
      }
    }
  }
}

async function processStatuses(statuses) {
  for (const statusObj of statuses) {
    const { id: messageId, status, recipient_id: phone, errors } = statusObj;
    log.debug(`Status Update: ${phone} -> ${status}`, { messageId });
    
    try {
      const updateData = { status };
      if (status === 'delivered') updateData.deliveredAt = new Date();
      if (status === 'read') updateData.readAt = new Date();
      if (status === 'failed') {
        updateData.failedAt = new Date();
        updateData.errorMessage = errors?.[0]?.message || 'Unknown error';
        log.warn(`Message failure for ${phone}`, { messageId, error: updateData.errorMessage });
      }

      const msg = await CampaignMessage.findOneAndUpdate(
        { messageId },
        { $set: updateData },
        { new: true }
      ).lean();

      if (msg) {
        // Update Campaign aggregate stats
        const inc = {};
        if (status === 'delivered') inc.deliveredCount = 1;
        if (status === 'read') inc.readCount = 1;
        if (status === 'failed') inc.failedCount = 1;

        if (Object.keys(inc).length > 0) {
          const updateObj = { $inc: inc };
          const arrayFilters = [];
          if (msg.abVariantLabel) {
            if (status === 'delivered') updateObj.$inc['abVariants.$[variant].deliveredCount'] = 1;
            if (status === 'read') updateObj.$inc['abVariants.$[variant].readCount'] = 1;
            if (status === 'failed') updateObj.$inc['abVariants.$[variant].failedCount'] = 1;
            arrayFilters.push({ 'variant.label': msg.abVariantLabel });
          }
          await Campaign.findByIdAndUpdate(msg.campaignId, updateObj, arrayFilters.length > 0 ? { arrayFilters } : {});
        }
        
        if (status === 'read' && msg.clientId) {
          const AdLead = require('../models/AdLead');
          AdLead.pushJourneyEvent(msg.clientId, msg.phone, 'campaign_read', { campaignId: msg.campaignId, variant: msg.abVariantLabel }).catch(() => {});
        }
      }
    } catch (err) {
      log.error(`Status update error for ${messageId}`, { error: err.message });
    }
  }
}

async function processMessages(messages, metadata, contacts) {
  for (const message of messages) {
    const from = message.from; 
    const messageId = message.id;
    const phone_number_id = metadata?.phone_number_id;

    try {
      // 1. DEDUPLICATION CHECK
      const existingConvo = await Conversation.findOne({ phone: from, processedMessageIds: messageId }, { _id: 1 }).lean();
      if (existingConvo) {
        log.debug(`Skipping duplicate message ${messageId} from ${from}`);
        continue; 
      }

      log.info(`Incoming from ${from}: ${message.type}`, { messageId });

      // 2. Extract Meta Referral (Ad Attribution)
      if (message.referral) {
        log.info(`[AdAttribution] Ad referral detected for ${from}`, { adId: message.referral.source_id });
      }

      // 3. Mark message as replied-to in any open Campaign
      CampaignMessage.findOneAndUpdate(
        { phone: from, status: { $in: ['sent', 'delivered', 'read'] } },
        { $set: { repliedAt: new Date(), status: 'replied' } },
        { sort: { createdAt: -1 }, lean: true }
      ).then(async (msg) => {
        if (msg?.campaignId) {
          const updateObj = { $inc: { repliedCount: 1 } };
          const arrayFilters = [];
          if (msg.abVariantLabel) {
            updateObj.$inc['abVariants.$[variant].repliedCount'] = 1;
            arrayFilters.push({ 'variant.label': msg.abVariantLabel });
          }
          await Campaign.findByIdAndUpdate(msg.campaignId, updateObj, arrayFilters.length > 0 ? { arrayFilters } : {});
          if (msg.clientId) {
            const AdLead = require('../models/AdLead');
            AdLead.pushJourneyEvent(msg.clientId, from, 'campaign_replied', { campaignId: msg.campaignId, variant: msg.abVariantLabel }).catch(() => {});
          }
        }
      }).catch(e => log.error('Campaign reply update failed', { error: e.message }));

      // B2. Handle WA Catalog Orders
      if (message.type === 'order') {
        try {
          const orderItems = message.order?.product_items || [];
          log.info(`🛒 WA Catalog order from ${from}`, { items: orderItems.length });

          const AdLead = require('../models/AdLead');
          const lead = await AdLead.findOneAndUpdate(
            { phoneNumber: from },
            {
              $set: {
                cartStatus: 'whatsapp_order_placed',
                lastInteraction: new Date(),
                'cartSnapshot.items': orderItems.map(i => ({ variant_id: i.product_retailer_id, quantity: i.quantity }))
              },
              $push: {
                activityLog: { action: 'whatsapp_catalog_order', details: `WA Catalog order: ${orderItems.length} item(s)`, timestamp: new Date() },
                commerceEvents: { event: 'whatsapp_order_placed', amount: 0, currency: 'INR', timestamp: new Date(), metadata: { items: orderItems, catalogOrderId: message.id } }
              }
            },
            { new: true, lean: true }
          );

          // Send acknowledgment
          handleWhatsAppMessage(from, { ...message, type: 'text', text: { body: `✅ Thank you! We've received your order for ${orderItems.length} item(s). Our team will confirm shortly.` }, _isCatalogAck: true }, phone_number_id, profileName).catch(e => log.error('Catalog Ack failed', { error: e.message }));

          // Fire external webhook
          const clientDoc = await require('../models/Client').findOne({ phoneNumberId: phone_number_id }, { _id: 1, clientId: 1 }).lean();
          if (clientDoc && lead) {
            try {
              require('../utils/webhookDelivery').fireWebhookEvent(clientDoc._id, 'order.created', { phone: from, items: orderItems, source: 'whatsapp_catalog' });
            } catch (_) {}

            // Create Dashboard Notification
            require('../utils/notificationService').createNotification(clientDoc.clientId, {
              type: 'system',
              title: 'New WhatsApp Order 🛒',
              message: `Order received from ${from} for ${orderItems.length} item(s)`,
              customerPhone: from,
              metadata: { items: orderItems }
            }).catch(() => {});

            // Phase 25: Referral & Journey
            const ReferralEngine = require('../utils/referralEngine');
            await ReferralEngine.markConverted(lead);
            AdLead.pushJourneyEvent(lead.clientId, from, 'order_placed', { itemsCount: orderItems.length }).catch(() => {});
          }
        } catch (orderErr) {
          log.error('Catalog order critical failure', { error: orderErr.message });
        }
        continue; // Don't process as regular message
      }

      // 4. Pass to processing engine
      const contact = (contacts || []).find(c => c.wa_id === from);
      const profileName = contact?.profile?.name || '';
      
      if (message.type === 'audio' || message.type === 'voice') {
        const { discoverClientByPhoneId } = require('../utils/clientDiscovery');
        const client = await discoverClientByPhoneId(phone_number_id);
        if (client) {
          const convo = await Conversation.findOneAndUpdate({ phone: from, clientId: client.clientId }, { $setOnInsert: { phone: from, clientId: client.clientId, botPaused: false, status: 'BOT_ACTIVE' } }, { upsert: true, new: true, lean: true });
          require('../utils/voiceNoteHandler').processVoiceNote(message, client, from, convo._id, global.io, phone_number_id, profileName).catch(e => log.error('VoiceNote error', { error: e.message }));
        }
        continue;
      }

      handleWhatsAppMessage(from, message, phone_number_id, profileName).catch(err => log.error("Engine processing error", { phone: from, error: err.message }));

    } catch (err) {
      log.error(`Message processing error for ${messageId}`, { phone: from, error: err.message });
    }
  }
}
  }
});

module.exports = router;
