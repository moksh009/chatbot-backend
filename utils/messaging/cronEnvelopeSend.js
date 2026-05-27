const {
  sendEnvelope,
  shouldUseSendEnvelope,
  interpretEnvelopeResult,
  intentFromTemplateCategory,
} = require('./envelopeHelpers');

function hasRealPhone(phone) {
  const p = String(phone || '');
  return !!(p && !/^unknown_/i.test(p) && p.replace(/\D/g, '').length >= 10);
}

function idempotencyCod({ orderId, stage, contactId, phone }) {
  return `cod:${orderId}:${stage}:${contactId || phone}`;
}

function idempotencyCsat({ conversationId, contactId }) {
  return `csat:${conversationId}:${contactId}`;
}

function idempotencyScheduled({ scheduledMessageId }) {
  return `sched:${scheduledMessageId}`;
}

/**
 * Cron/automation send via sendEnvelope (always).
 * Returns { useLegacy: true } only when contact cannot be resolved for envelope.
 */
async function cronEnvelopeSend({
  client,
  clientId,
  channel = 'whatsapp',
  intent = 'marketing',
  phone = null,
  contactId = null,
  email = null,
  idempotencyKey,
  payload = {},
  context = {},
  options = {},
}) {
  const envelope = {
    clientId,
    channel,
    intent,
    payload,
    context: { source: context.source || 'cron', ...context },
    options,
    idempotency: idempotencyKey ? { key: idempotencyKey } : undefined,
  };

  if (contactId) {
    envelope.contactId = String(contactId);
  } else if (channel === 'email' && email) {
    envelope.contact = { email: String(email).trim().toLowerCase() };
  } else if (phone && hasRealPhone(phone)) {
    envelope.contact = { phone };
  } else {
    return { useLegacy: true, reason: 'no_contact_key' };
  }

  const result = await sendEnvelope(envelope);
  return { useLegacy: false, ...interpretEnvelopeResult(result) };
}

function handleCronEnvelopeOutcome(out, handlers = {}) {
  if (!out || out.useLegacy) return 'legacy';
  if (out.action === 'sent') {
    handlers.onSent?.(out);
    return 'sent';
  }
  if (out.action === 'duplicate') {
    handlers.onDuplicate?.(out);
    return 'duplicate';
  }
  if (out.action === 'rate_limit') {
    handlers.onRateLimit?.(out);
    return 'rate_limit';
  }
  if (out.action === 'skipped') {
    handlers.onSkipped?.(out);
    return 'skipped';
  }
  handlers.onFailed?.(out);
  return 'failed';
}

module.exports = {
  cronEnvelopeSend,
  handleCronEnvelopeOutcome,
  hasRealPhone,
  intentFromTemplateCategory,
  shouldUseSendEnvelope,
  idempotencyCod,
  idempotencyCsat,
  idempotencyScheduled,
  buildRecoveryUrl: require('../commerce/buildRecoveryUrl').buildRecoveryUrl,
  buildCartRecoveryComponents: require('../commerce/buildCartRecoveryComponents').buildCartRecoveryComponents,
};
