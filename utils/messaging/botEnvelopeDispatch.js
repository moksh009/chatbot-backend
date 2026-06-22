const Conversation = require('../../models/Conversation');
const { sendEnvelope } = require('./sendEnvelope');
const { findLeadByPhone } = require('../commerce/inboundReOptInService');

async function resolveBotContext(client, phone, opts = {}) {
  let conversationId = opts.conversationId;
  let contactId = opts.contactId;
  let detectedLanguage = opts.detectedLanguage;

  if (!conversationId || !detectedLanguage) {
    const convo = await Conversation.findOne({ phone, clientId: client.clientId })
      .select('_id detectedLanguage lastInboundAt')
      .lean();
    if (convo) {
      conversationId = conversationId || convo._id;
      detectedLanguage = detectedLanguage || convo.detectedLanguage;
    }
  }

  if (!contactId) {
    const lead = await findLeadByPhone(client.clientId, phone);
    contactId = lead?._id;
  }

  const messageId = opts.messageId || opts.inboundMessageId || `out_${Date.now()}`;
  const idempotencyKey = opts.idempotencyKey || `bot:${conversationId || phone}:${messageId}`;

  return { conversationId, contactId, detectedLanguage, messageId, idempotencyKey };
}

/** Bot/runtime outbound via envelope. */
async function dispatchBotEnvelope({
  client,
  phone,
  channel = 'whatsapp',
  intent = 'service',
  payload,
  opts = {},
}) {
  const ctx = await resolveBotContext(client, phone, opts);
  const envelope = {
    clientId: client.clientId,
    channel,
    intent,
    payload,
    idempotency: { key: ctx.idempotencyKey },
    context: {
      source: opts.source || 'dualBrainEngine',
      conversationId: ctx.conversationId ? String(ctx.conversationId) : undefined,
    },
  };

  if (ctx.contactId) envelope.contactId = String(ctx.contactId);
  else envelope.contact = { phone };

  if (opts.complianceExempt === true) {
    envelope.options = { ...(envelope.options || {}), complianceExempt: true };
  }

  let result = await sendEnvelope(envelope);

  const source = String(opts.source || '');
  const isDualBrain = source.startsWith('dualBrainEngine');
  const consentBlocked =
    result.status === 'blocked' &&
    result.blockedBy === 'consent' &&
    result.reason === 'recipient_opted_out';

  if (consentBlocked && isDualBrain && !opts._reoptInRetried) {
    try {
      const { executeInboundReOptIn } = require('../commerce/inboundReOptInService');
      const reopt = await executeInboundReOptIn({
        client,
        phone,
        source: 'inbound_message',
        silent: true,
      });
      if (reopt.success && !reopt.skipped) {
        result = await sendEnvelope({
          ...envelope,
          idempotency: { key: `${ctx.idempotencyKey}:reopt-retry` },
        });
      }
    } catch (_) {
      /* fall through to blocked response */
    }
  }

  if (result.status === 'sent' || result.status === 'queued') {
    return {
      handled: true,
      sent: true,
      messageId: result.messageId,
      result,
    };
  }

  if (result.status === 'duplicate') {
    return { handled: true, sent: false, duplicate: true, result };
  }

  const windowClosed =
    result.blockedBy === 'service_window' ||
    result.reason === 'window_closed' ||
    result.reason === 'outside_service_window';

  return {
    handled: true,
    sent: false,
    blocked: true,
    windowClosed,
    reason: result.reason || result.blockedBy || result.status,
    result,
  };
}

async function dispatchAgentEnvelope({
  client,
  phone,
  payload,
  userId,
  conversationId,
  contactId,
  messageId,
}) {
  const idempotencyKey = `agent:${userId}:${messageId || Date.now()}`;
  return dispatchBotEnvelope({
    client,
    phone,
    intent: 'service',
    payload,
    opts: {
      conversationId,
      contactId,
      messageId,
      idempotencyKey,
      source: 'routes/conversations:agent_send',
    },
  });
}

module.exports = {
  dispatchBotEnvelope,
  dispatchAgentEnvelope,
  resolveBotContext,
};
