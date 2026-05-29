'use strict';

/**
 * Unified Meta Master Webhook — POST /api/webhooks/meta-master
 *
 * Handles ALL WhatsApp Business Account event types for Embedded Signup merchants:
 *   messages, message_template_status_update, account_update,
 *   business_capability_update, phone_number_quality_update
 *
 * Existing per-tenant webhooks (/api/client/:clientId/webhook) continue to
 * work unchanged for manual-connect merchants.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const log = require('../utils/core/logger')('MetaMasterWebhook');
const Client = require('../models/Client');
const { handleMessageTemplateStatusWebhook } = require('../services/templateLifecycleBridge');
const { emitToClient } = require('../utils/core/socket');
const { logActivity } = require('../utils/core/activityLogger');

// ─── HMAC signature verification ─────────────────────────────────────────────

function verifySignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = process.env.META_APP_SECRET;

  if (!appSecret) {
    log.error('META_APP_SECRET not configured');
    return res.status(500).send('Webhook verification misconfigured');
  }

  if (!signature) {
    log.warn('Missing X-Hub-Signature-256 — rejecting');
    return res.status(401).send('Signature missing');
  }

  const payload = req.rawBody ? req.rawBody : JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest('hex');
  const provided = signature.replace(/^sha256=/i, '');

  let signatureValid = false;
  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(provided, 'hex');
    // timingSafeEqual throws if lengths differ — treat that as a mismatch
    if (expectedBuf.length === providedBuf.length) {
      signatureValid = crypto.timingSafeEqual(expectedBuf, providedBuf);
    }
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    log.error('Signature mismatch — possible spoofed webhook');
    logActivity('system', {
      type: 'security.webhook_signature_mismatch',
      title: 'Meta Webhook Signature Mismatch',
      description: 'Received a POST to meta-master with invalid HMAC. Rejected.',
      severity: 'error',
    }).catch(() => {});
    return res.status(401).send('Signature mismatch');
  }

  next();
}

// ─── Idempotency (Redis-backed, 24h TTL) ─────────────────────────────────────

const _localDedup = new Map(); // fallback if Redis unavailable

async function isDuplicate(key) {
  try {
    const { getAppRedis } = require('../utils/core/redisFactory');
    const redis = getAppRedis();
    if (redis && redis.status === 'ready') {
      const result = await redis.set(`wh-dedup:${key}`, '1', 'EX', 86400, 'NX');
      return result === null;
    }
  } catch (_) {}
  if (_localDedup.has(key)) return true;
  _localDedup.set(key, true);
  setTimeout(() => _localDedup.delete(key), 86400000);
  return false;
}

// ─── Tenant resolution ───────────────────────────────────────────────────────

async function resolveClient(phoneNumberId, wabaId) {
  const query = [];
  if (phoneNumberId) query.push({ phoneNumberId });
  if (wabaId) query.push({ wabaId });
  if (!query.length) return null;
  return Client.findOne({ $or: query }).select('clientId whatsappQualityHistory').lean();
}

// ─── GET — webhook verification ──────────────────────────────────────────────

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    log.info('Meta master webhook verified');
    return res.status(200).send(challenge);
  }
  log.warn('Meta master webhook verification failed', { mode, token: token?.slice(0, 8) });
  return res.status(403).end();
});

// ─── POST — event handling ───────────────────────────────────────────────────

router.post('/', verifySignature, async (req, res) => {
  // Ack immediately — Meta requires response < 1s
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  if (!body?.entry) return;

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const field = change.field;
      const value = change.value;

      // Idempotency key
      const dedupKey = `${entry.id}:${field}:${JSON.stringify(value).length}:${value?.id || ''}`;
      if (await isDuplicate(dedupKey)) continue;

      try {
        switch (field) {
          case 'messages':
            // Delegate to existing master webhook message handler
            await handleMessages(value);
            break;

          case 'message_template_status_update':
            await handleTemplateStatus(entry, value);
            break;

          case 'account_update':
            await handleAccountUpdate(entry, value);
            break;

          case 'business_capability_update':
            await handleCapabilityUpdate(entry, value);
            break;

          case 'phone_number_quality_update':
            await handleQualityUpdate(entry, value);
            break;

          default:
            log.debug('Unhandled webhook field', { field, wabaId: entry.id });
        }
      } catch (err) {
        log.error('Webhook field handler error', { field, error: err.message });
      }
    }
  }
});

// ─── Field handlers ───────────────────────────────────────────────────────────

async function handleMessages(value) {
  // Delegate to existing message processing infrastructure
  const { handleWhatsAppMessage, saveInboundMessage } = require('../utils/commerce/dualBrainEngine');
  if (!value?.messages?.length) return;

  const phoneNumberId = value?.metadata?.phone_number_id;
  const client = await resolveClient(phoneNumberId, null);
  if (!client) {
    log.debug('handleMessages: no client for phone_number_id', { phoneNumberId });
    return;
  }

  for (const msg of value.messages) {
    try {
      await saveInboundMessage(msg, value.metadata, value.contacts, client.clientId);
    } catch (err) {
      log.error('Message save failed', { msgId: msg.id, error: err.message });
    }
  }
}

async function handleTemplateStatus(entry, value) {
  const clientId = await resolveClientIdFromWABAEntry(entry);
  if (!clientId) {
    log.warn('Template status: unknown WABA', { wabaId: entry?.id });
    return;
  }
  await handleMessageTemplateStatusWebhook(clientId, value);
}

async function handleAccountUpdate(entry, value) {
  const client = await resolveClient(value?.phone_number_id, entry?.id);
  if (!client) {
    log.debug('account_update: no client resolved', { wabaId: entry?.id });
    return;
  }
  const { clientId } = client;
  const event = value?.event;

  log.info('account_update', { clientId, event });

  switch (event) {
    case 'onboarding_complete':
      await Client.findOneAndUpdate({ clientId }, { $set: { whatsappOnboardingCompleted: true } });
      emitToClient(clientId, 'wa:onboarding_complete', { event });
      break;

    case 'phone_number_added':
      await logActivity(clientId, {
        type: 'whatsapp.phone_added',
        title: 'New phone number added to WABA',
        description: `Meta reported a new phone added: ${value?.phone_number || ''}`,
        severity: 'info',
      });
      break;

    case 'account_review_update': {
      const status = value?.decision === 'APPROVED' ? 'active' : 'under_review';
      await Client.findOneAndUpdate({ clientId }, { $set: { whatsappAccountStatus: status } });
      emitToClient(clientId, 'wa:account_review_update', { status, decision: value?.decision });
      break;
    }

    case 'account_restriction': {
      await Client.findOneAndUpdate(
        { clientId },
        { $set: { whatsappRestricted: true, whatsappAccountStatus: 'restricted' } }
      );
      emitToClient(clientId, 'wa:account_restricted', { restriction: value?.restriction_info });
      await logActivity(clientId, {
        type: 'whatsapp.account_restricted',
        title: 'WhatsApp Account Restricted',
        description: `Meta has restricted this WhatsApp account. Reason: ${value?.restriction_info?.restriction_type || 'Unknown'}`,
        severity: 'error',
      });
      break;
    }

    default:
      log.debug('account_update: unhandled event', { clientId, event });
  }
}

async function handleCapabilityUpdate(entry, value) {
  const client = await resolveClient(value?.phone_number_id, entry?.id);
  if (!client) return;
  const { clientId } = client;

  const newLimit = value?.max_daily_conversation_per_phone || value?.messaging_limit_tier || '';
  if (newLimit) {
    await Client.findOneAndUpdate({ clientId }, { $set: { whatsappMessagingLimit: String(newLimit) } });
    emitToClient(clientId, 'wa:capability_update', { messagingLimit: newLimit });
    log.info('Messaging limit updated', { clientId, newLimit });
  }
}

async function handleQualityUpdate(entry, value) {
  // entry.id = WABA ID, value.id = phone_number_id (numeric)
  const client = await resolveClient(value?.id || null, entry?.id || null);
  if (!client) return;
  const { clientId } = client;

  const newRating = (value?.current_limit || value?.new_quality_score || '').toUpperCase();
  const validRatings = ['GREEN', 'YELLOW', 'RED'];
  if (!validRatings.includes(newRating)) return;

  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: { whatsappQualityRating: newRating },
      $push: { whatsappQualityHistory: { $each: [{ rating: newRating, changedAt: new Date() }], $slice: -30 } },
    }
  );

  emitToClient(clientId, 'wa:quality_update', { rating: newRating });

  if (newRating === 'RED') {
    await logActivity(clientId, {
      type: 'whatsapp.quality_red',
      title: 'WhatsApp Quality Rating Dropped to Red',
      description: 'Your WhatsApp quality rating is now RED. Review recent messages to avoid account restrictions.',
      severity: 'warn',
    });
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

async function resolveClientIdFromWABAEntry(entry) {
  const wabaId = String(entry?.id || '').trim();
  if (!wabaId) return null;
  const row = await Client.findOne({ $or: [{ wabaId }, { 'whatsapp.wabaId': wabaId }] })
    .select('clientId').lean();
  return row?.clientId || null;
}

module.exports = router;
