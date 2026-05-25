const Conversation = require('../../models/Conversation');
const AdLead = require('../../models/AdLead');
const { sendEnvelope } = require('./sendEnvelope');

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
    const lead = await AdLead.findOne({ clientId: client.clientId, phoneNumber: phone })
      .select('_id')
      .lean();
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

  const result = await sendEnvelope(envelope);

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
