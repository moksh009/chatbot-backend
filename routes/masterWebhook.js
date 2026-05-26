const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const log = require('../utils/core/logger')('MasterWebhook');
const Conversation = require('../models/Conversation');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const { handleWhatsAppMessage, saveInboundMessage, handleWhatsAppCatalogOrder } = require('../utils/commerce/dualBrainEngine');
const { logActivity } = require('../utils/core/activityLogger');
const { recalculateLeadScore } = require('../utils/core/scoringHelper');
const { buildEventEnvelope } = require('../utils/flow/eventEnvelope');
const { emitToClient } = require('../utils/core/socket');
const { phoneNumberIdMatchFilter } = require('../utils/meta/clientWhatsAppCreds');
const { getMetaWebhookVerifyQuery } = require('../utils/meta/metaHubQuery');
const { handleMessageTemplateStatusWebhook } = require('../services/templateLifecycleBridge');
const Client = require('../models/Client');

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
  
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    log.error("META_APP_SECRET not configured — cannot verify webhook signature");
    return res.status(500).send('Webhook verification not configured');
  }
  
  // Use req.rawBody if available for accurate HMAC verification
  const payload = req.rawBody ? req.rawBody : JSON.stringify(req.body);
  const expectedHash = crypto
    .createHmac('sha256', appSecret)
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
    const { mode, token, challenge } = getMetaWebhookVerifyQuery(req);
    const verifyToken =
      process.env.VERIFY_TOKEN ||
      process.env.WHATSAPP_VERIFY_TOKEN ||
      'my_verify_token';

    if (mode === 'subscribe' && token === verifyToken) {
        log.info('Webhook Root Verified');
        return res.status(200).send(challenge);
    }
    res.status(403).end();
});

const { metaPayloadReplayGuard } = require('../middleware/webhookReplayGuard');

// 2. Master Webhook Handling (POST)
router.post('/', verifyMetaSignature, metaPayloadReplayGuard(), async (req, res) => {
  if (req.webhookReplayDuplicate) return;
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
async function resolveClientIdFromWabaEntry(entry) {
  const wabaId = String(entry?.id || '').trim();
  if (!wabaId) return null;
  const row = await Client.findOne({
    $or: [{ wabaId }, { 'whatsapp.wabaId': wabaId }],
  })
    .select('clientId')
    .lean();
  return row?.clientId || null;
}

async function processTemplateStatusUpdates(entry, change) {
  const value = change?.value;
  if (!value?.event || !value?.message_template_name) return;

  const clientId = await resolveClientIdFromWabaEntry(entry);
  if (!clientId) {
    log.warn('[MasterWebhook] template status: unknown WABA', { wabaId: entry?.id });
    return;
  }

  await handleMessageTemplateStatusWebhook(clientId, value);
}

async function processWebhookEntries(entries) {
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value) continue;

      // A. Meta template review outcome (APPROVED / REJECTED / …)
      if (change.field === 'message_template_status_update') {
        processTemplateStatusUpdates(entry, change).catch((e) =>
          log.error('Template status webhook failure', { error: e.message })
        );
        continue;
      }

      // B. Message delivery status (delivered, read, failed)
      if (value.statuses) {
        processStatuses(value.statuses).catch(e => log.error('Status processing failure', { error: e.message }));
      }

      // C. Incoming customer messages
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
        
        // Phase 28: Auto-Healing
        if (msg?.clientId) {
            const { reportApiFailure } = require('../utils/core/autoHealer');
            reportApiFailure(msg.clientId, { response: { data: { error: errors?.[0] } } }).catch(() => {});
        }
      }

      const msg = await CampaignMessage.findOneAndUpdate(
        { messageId },
        { $set: updateData },
        { new: true }
      ).lean();

      // ✅ Phase R3: Emit real-time status update to Live Chat UI — was missing, ticks never updated
      // Frontend LiveChat listens for 'message_status_update' to show ✓ / ✓✓ / blue ✓✓
      if (global.io) {
        // Find the conversation's clientId to emit to correct room
        const Message = require('../models/Message');
        const liveMsg = await Message.findOne({ messageId }).lean();
        if (liveMsg?.clientId) {
          global.io.to(`client_${liveMsg.clientId}`).emit('message_status_update', {
            messageId,
            status,
            conversationId: liveMsg.conversationId,
            deliveredAt: updateData.deliveredAt,
            readAt: updateData.readAt
          });
        }
      }

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
  const { isDuplicateInbound } = require('../utils/meta/webhookDedup');

  for (const message of messages) {
    const from = message.from; 
    const messageId = message.id;
    const phone_number_id = metadata?.phone_number_id;

    if (!phone_number_id) {
      log.warn(`[MasterWebhook] Skipping message ${messageId}: missing metadata.phone_number_id`);
      continue;
    }

    try {
      const waClientFilter = phoneNumberIdMatchFilter(phone_number_id);
      const clientDocForDedup = waClientFilter
        ? await require('../models/Client').findOne(waClientFilter, { clientId: 1 }).lean()
        : null;
      if (messageId && clientDocForDedup?.clientId) {
        if (await isDuplicateInbound(messageId, clientDocForDedup.clientId)) {
          log.debug(`Skipping duplicate message ${messageId} from ${from}`);
          continue;
        }
      }

      const existingConvo = await Conversation.findOne({ phone: from, processedMessageIds: messageId }, { _id: 1 }).lean();
      if (existingConvo) {
        log.debug(`Skipping duplicate message ${messageId} from ${from} (legacy dedup)`);
        continue; 
      }

      log.info(`Incoming from ${from}: ${message.type}`, { messageId });
      const clientDocForEnvelope = clientDocForDedup;
      if (clientDocForEnvelope?.clientId) {
        const envelope = buildEventEnvelope({
          channel: 'whatsapp',
          eventType: 'inbound_message',
          clientId: clientDocForEnvelope.clientId,
          userId: from,
          message: {
            id: messageId,
            type: message.type,
            from
          },
          payload: { message, contacts, metadata },
          meta: { source: 'master_webhook' }
        });
        emitToClient(clientDocForEnvelope.clientId, 'orchestration:event', envelope);
        const { touchInboundWebhook } = require('../utils/meta/whatsappWebhookLifecycle');
        touchInboundWebhook(clientDocForEnvelope.clientId).catch(() => {});
      }

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

          const Client = require('../models/Client');
          const clientDoc = waClientFilter ? await Client.findOne(waClientFilter).lean() : null;
          if (!clientDoc?.clientId) {
            log.warn('Catalog order received but client not found by phoneNumberId', { phone_number_id });
            continue;
          }

          let coResult = {
            shortUrl: '',
            checkoutUrl: '',
            totalPrice: 0
          };
          try {
            coResult = await handleWhatsAppCatalogOrder(clientDoc, from, message.order || {});
          } catch (ce) {
            log.error(`[CatalogOrder] handleWhatsAppCatalogOrder failed: ${ce.message}`);
          }

          const AdLead = require('../models/AdLead');
          const lead = await AdLead.findOneAndUpdate(
            { clientId: clientDoc.clientId, phoneNumber: from },
            {
              $set: {
                cartStatus: 'whatsapp_order_placed',
                lastInteraction: new Date(),
                checkoutUrl: coResult.shortUrl || '',
                cartUrl: coResult.checkoutUrl || '',
                'cartSnapshot.items': orderItems,
                'cartSnapshot.totalPrice': coResult.totalPrice,
                'cartSnapshot.total_price': coResult.totalPrice,
                'cartSnapshot.updatedAt': new Date()
              },
              $push: {
                activityLog: { action: 'whatsapp_catalog_order', details: `WA Catalog order: ${orderItems.length} item(s)`, timestamp: new Date() },
                commerceEvents: {
                  event: 'whatsapp_order_placed',
                  amount: coResult.totalPrice || 0,
                  currency: orderItems[0]?.currency || 'INR',
                  timestamp: new Date(),
                  metadata: {
                    items: orderItems,
                    catalogOrderId: message.id,
                    checkoutUrl: coResult.shortUrl || ''
                  }
                }
              }
            },
            { new: true, lean: true, upsert: true, setDefaultsOnInsert: true }
          );

          // Fire external webhook
          if (clientDoc && lead) {
            try {
              require('../utils/core/webhookDelivery').fireWebhookEvent(clientDoc._id, 'order.created', {
                phone: from,
                items: orderItems,
                checkoutUrl: coResult.shortUrl || '',
                source: 'whatsapp_catalog'
              });
            } catch (_) {}

            // Create Dashboard Notification
            require('../utils/core/notificationService').createNotification(clientDoc.clientId, {
              type: 'system',
              title: 'New WhatsApp Order 🛒',
              message: `Order received from ${from} for ${orderItems.length} item(s)`,
              customerPhone: from,
              metadata: { items: orderItems }
            }).catch(() => {});

            // Phase 25: Referral & Journey
            const ReferralEngine = require('../utils/commerce/referralEngine');
            await ReferralEngine.markConverted(lead);
            AdLead.pushJourneyEvent(lead.clientId, from, 'order_placed', { itemsCount: orderItems.length }).catch(() => {});

            // Enterprise Pulse Log: WhatsApp Order
            await logActivity(clientDoc.clientId, {
                type: 'ORDER',
                status: 'success',
                title: 'WhatsApp Catalog Order 🛒',
                message: `New catalog order from ${from} for ${orderItems.length} items.`,
                icon: 'ShoppingBag',
                url: `/conversations?phone=${from}`,
                metadata: {
                    phone: from,
                    itemCount: orderItems.length,
                    source: 'whatsapp_catalog'
                }
            });

            // TRIGGER WATERFALL ENGINE: Update score in real-time
            await recalculateLeadScore(clientDoc.clientId, from).catch(e => log.error('Scoring recompute failed:', e.message));
          }
        } catch (orderErr) {
          log.error('Catalog order critical failure', { error: orderErr.message });
        }
        continue; // Don't process as regular message
      }

      // 4. pass to processing engine
      const contact = (contacts || []).find(c => c.wa_id === from);
      const profileName = contact?.profile?.name || '';
      
      // Phase 29: Track 6 - Supplier B2B Bypass
      const Supplier = require('../models/Supplier');
      const Client = require('../models/Client');
      const client = waClientFilter ? await Client.findOne(waClientFilter).lean() : null;
      
      if (client) {
        const isSupplier = await Supplier.exists({ clientId: client._id, phone: from });
        if (isSupplier) {
          log.info(`[B2B] Supplier message detected from ${from}. Bypassing AI engine.`);
          // Mark convo as supplier and notify agent
          await Conversation.findOneAndUpdate(
            { phone: from, clientId: client.clientId },
            { $set: { isSupplierMessage: true, status: 'HUMAN_TAKEOVER' } },
            { upsert: true }
          );
          
          const NotificationService = require('../utils/core/notificationService');
          NotificationService.notifyAgent(client.clientId, {
            type: 'alert',
            title: 'Vendor Message 📦',
            message: `New message from supplier ${from}.`,
            customerPhone: from
          }).catch(() => {});
          
          // Still save message but skip dualBrainEngine
          const { saveInboundMessage } = require('../utils/commerce/dualBrainEngine');
          await saveInboundMessage(from, client.clientId, message, global.io, 'whatsapp');
          return;
        }
      }

      if (message.type === 'audio' || message.type === 'voice') {
        const { discoverClientByPhoneId } = require('../utils/core/clientDiscovery');
        const client = await discoverClientByPhoneId(phone_number_id);
        if (client) {
          const convo = await Conversation.findOneAndUpdate({ phone: from, clientId: client.clientId }, { $setOnInsert: { phone: from, clientId: client.clientId, botPaused: false, status: 'BOT_ACTIVE' } }, { upsert: true, new: true, lean: true });
          require('../utils/meta/voiceNoteHandler').processVoiceNote(message, client, from, convo._id, global.io, phone_number_id, profileName).catch(e => log.error('VoiceNote error', { error: e.message }));
        }
        continue;
      }

      // 4. Route to primary engine pipeline
      // handleWhatsAppMessage is the SINGLE entry point that parses the payload,
      // resolves the client, and calls runDualBrainEngine internally.
      // DO NOT use processInboundMessage (deleted legacy dual-pipeline).
      handleWhatsAppMessage(message, from, phone_number_id, (contacts || []).find(c => c.wa_id === from)?.profile?.name || '')
        .then(async () => {
          const Client = require('../models/Client');
          const cdoc = waClientFilter
            ? await Client.findOne(waClientFilter).select('clientId').lean()
            : null;
          if (cdoc?.clientId) recalculateLeadScore(cdoc.clientId, from).catch(() => {});
        })
        .catch(err => log.error("Engine processing error", { phone: from, error: err.message }));

    } catch (err) {
      log.error(`Message processing error for ${messageId}`, { phone: from, error: err.message });
    }
  }
}

module.exports = router;
