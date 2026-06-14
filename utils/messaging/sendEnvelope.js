const crypto = require('crypto');
const Client = require('../../models/Client');
const { writeAuditLog } = require('./writeAuditLog');
const { resolveChannelRateLimits, applyRateLimitThrottle, isRateLimitError } = require('./channelRateLimits');
const MessageEnvelope = require('../../models/MessageEnvelope');
const { emitToClient } = require('../core/socket');
const { getAppRedis } = require('../core/redisFactory');
const { incrementUsage } = require('../core/planLimits');
const { generateIdempotencyKey, resolveWindowBucket } = require('./idempotency');
const { consumeTokenBucket } = require('./rateLimits');
const { sendWhatsApp, sendEmailMessage, sendInstagram } = require('./transports');
const { dispatchTrackedEmail } = require('../core/dispatchTrackedEmail');
const { checkEmailDailyLimit, incrementEmailCount } = require('../core/emailRateLimiter');
const { validateInput } = require('./checks/validateInput');
const { resolveContact } = require('./checks/resolveContact');
const { checkIdempotency } = require('./checks/checkIdempotency');
const { checkChannelEnabled } = require('./checks/checkChannelEnabled');
const { checkConsent } = require('./checks/checkConsent');
const { checkSuppression } = require('./checks/checkSuppression');
const { checkServiceWindow } = require('./checks/checkServiceWindow');
const { checkTemplateApproval } = require('./checks/checkTemplateApproval');
const { checkPlanLimit } = require('./checks/checkPlanLimit');
const {
  WHATSAPP_CREDENTIAL_SELECT,
  EMAIL_CREDENTIAL_SELECT,
  isWhatsAppOutboundReady,
} = require('../meta/clientWhatsAppCreds');
const { isWorkspaceEmailReady } = require('../core/emailService');

function buildResult(status, extra = {}) {
  return { status, ...extra };
}

async function persistEnvelope(doc) {
  try {
    await MessageEnvelope.create(doc);
  } catch (err) {
    // non-fatal
  }
}

function buildPersistContext(input, contact) {
  const base = { ...(input.context || {}) };
  if (input.channel === 'email') {
    base.subject = input?.payload?.subject || base.subject || '';
    base.recipientEmail = contact?.email || base.recipientEmail || '';
  }
  return base;
}

async function sendEnvelope(input = {}) {
  const redis = getAppRedis();
  const valid = validateInput(input);
  if (!valid.pass) return buildResult('blocked', valid);

  const credSelect =
    input.channel === 'email'
      ? EMAIL_CREDENTIAL_SELECT
      : input.channel === 'whatsapp'
        ? WHATSAPP_CREDENTIAL_SELECT
        : `${WHATSAPP_CREDENTIAL_SELECT} ${EMAIL_CREDENTIAL_SELECT}`;

  const client = await Client.findOne({ clientId: input.clientId }).select(credSelect).lean();
  if (!client) return buildResult('blocked', { blockedBy: 'invalid_contact', reason: 'client_not_found' });

  if (input.channel === 'whatsapp' && !isWhatsAppOutboundReady(client)) {
    return buildResult('blocked', {
      blockedBy: 'whatsapp_credentials',
      reason: 'whatsapp_not_configured',
      message:
        'WhatsApp credentials are missing or incomplete. Reconnect in Settings → Connections (Meta embedded signup or manual credentials).',
    });
  }

  if (input.channel === 'email' && !isWorkspaceEmailReady(client)) {
    return buildResult('blocked', {
      blockedBy: 'email_credentials',
      reason: 'email_not_configured',
      message: 'Gmail or SMTP is not connected. Connect email in Settings → Connections.',
    });
  }

  const contactRes = await resolveContact(input);
  if (!contactRes.pass) return buildResult('blocked', contactRes);
  const contact = contactRes.contact;

  const { bucket, ttlSec } = resolveWindowBucket(input.intent);
  const idemKey =
    input?.idempotency?.key ||
    generateIdempotencyKey({
      clientId: input.clientId,
      contactId: String(contact._id),
      channel: input.channel,
      intent: input.intent,
      payload: input.payload,
      step: input?.context?.step || '',
    });
  const idem = await checkIdempotency({ redis, key: idemKey, ttlSec: input?.idempotency?.ttlSec || ttlSec });
  if (!idem.pass) {
    await persistEnvelope({
      clientId: input.clientId,
      contactId: contact._id,
      channel: input.channel,
      intent: input.intent,
      status: 'duplicate',
      blockedBy: 'idempotency',
      reason: idem.reason,
      templateName: input?.payload?.templateName || '',
      idempotencyKey: idemKey,
      context: buildPersistContext(input, contact),
    });
    return buildResult('duplicate', { blockedBy: 'idempotency', reason: idem.reason });
  }

  const channelEnabled = checkChannelEnabled({ client, channel: input.channel });
  if (!channelEnabled.pass) return buildResult('blocked', channelEnabled);

  const consent = checkConsent({
    contact,
    channel: input.channel,
    intent: input.intent,
    strictMode: client?.complianceConfig?.strictMode !== false,
    complianceExempt: input?.options?.complianceExempt === true,
  });
  if (!consent.pass && !input?.options?.force) {
    await persistEnvelope({
      clientId: input.clientId,
      contactId: contact._id,
      channel: input.channel,
      intent: input.intent,
      status: 'blocked',
      blockedBy: 'consent',
      reason: consent.reason,
      templateName: input?.payload?.templateName || '',
      idempotencyKey: idemKey,
      context: buildPersistContext(input, contact),
      consentSnapshot: consent.consentSnapshot || null,
    });
    return buildResult('blocked', {
      blockedBy: 'consent',
      reason: consent.reason,
      consentSnapshot: consent.consentSnapshot || null,
    });
  }

  if (input?.options?.force) {
    if (input?.context?.actorRole !== 'SUPER_ADMIN') {
      return buildResult('blocked', { blockedBy: 'consent', reason: 'force_requires_super_admin' });
    }
    await writeAuditLog({
      clientId: input.clientId,
      action_type: 'force_send',
      target_resource: String(contact._id),
      actor: {
        type: 'super_admin',
        userId: input?.context?.actorUserId || input?.context?.actorId,
        source: input?.context?.source || 'dashboard',
        ip: input?.context?.ip,
        userAgent: input?.context?.userAgent,
      },
      payload: {
        reason: input?.options?.reason || 'force_send',
        channel: input.channel,
        intent: input.intent,
        consentSnapshot: consent.consentSnapshot || null,
      },
    }).catch(() => {});
  }

  const suppression = await checkSuppression({
    redis,
    clientId: input.clientId,
    channel: input.channel,
    contact,
  });
  if (!suppression.pass) return buildResult('blocked', suppression);

  const serviceWindow = checkServiceWindow({ channel: input.channel, intent: input.intent, payload: input.payload, contact });
  if (!serviceWindow.pass) return buildResult('blocked', serviceWindow);

  const templateCheck = await checkTemplateApproval({
    redis,
    clientId: input.clientId,
    payload: input.payload,
    intent: input.intent,
  });
  if (!templateCheck.pass) return buildResult('blocked', templateCheck);

  const plan = await checkPlanLimit({ clientId: input.clientId });
  if (!plan.pass) return buildResult('blocked', plan);

  const { sustainedPerSec, burst } = await resolveChannelRateLimits(client, input.channel);
  const tenantRate = await consumeTokenBucket(redis, {
    key: `${input.clientId}:${input.channel}`,
    capacity: burst,
    refillPerSec: sustainedPerSec,
  });
  if (!tenantRate.pass) {
    return buildResult('blocked', {
      blockedBy: 'rate_limit',
      reason: 'tenant_rate_limit',
      retryAfter: tenantRate.retryAfter,
    });
  }

  if (input?.options?.dryRun) {
    return buildResult('queued', { reason: 'dry_run', consentSnapshot: consent.consentSnapshot || null });
  }

  if (input.channel === 'email') {
    const dailyLimit = await checkEmailDailyLimit(input.clientId, 1);
    if (!dailyLimit.allowed) {
      await persistEnvelope({
        clientId: input.clientId,
        contactId: contact._id,
        channel: input.channel,
        intent: input.intent,
        status: 'blocked',
        blockedBy: 'rate_limit',
        reason: 'daily_limit_reached',
        templateName: input?.payload?.templateName || '',
        idempotencyKey: idemKey,
        context: buildPersistContext(input, contact),
        consentSnapshot: consent.consentSnapshot || null,
      });
      return buildResult('blocked', {
        blockedBy: 'rate_limit',
        reason: 'daily_limit_reached',
        remaining: dailyLimit.remaining,
        limit: dailyLimit.limit,
        consentSnapshot: consent.consentSnapshot || null,
      });
    }
  }

  try {
    let dispatchResult = null;
    let preCreatedEnvelopeId = null;

    if (input.channel === 'email') {
      const tracked = await dispatchTrackedEmail({
        client,
        clientId: input.clientId,
        to: contact.email,
        subject: input.payload?.subject || 'Store update',
        html: input.payload?.html || input.payload?.text || '',
        text: input.payload?.text,
        format: input.payload?.format,
        intent: input.intent,
        contactId: contact._id,
        context: buildPersistContext(input, contact),
        idempotencyKey: idemKey,
        templateName: input?.payload?.templateName || input.payload?.subject || '',
        consentSnapshot: consent.consentSnapshot || null,
        skipRateLimit: true,
      });
      dispatchResult = { messageId: tracked.messageId || null };
      preCreatedEnvelopeId = tracked.envelopeId;
    } else if (input.channel === 'instagram') {
      dispatchResult = await sendInstagram({
        client,
        payload: input.payload,
      });
    } else {
      dispatchResult = await sendWhatsApp({
        client,
        to: contact.phoneNumber,
        payload: input.payload,
      });
    }

    await incrementUsage(input.clientId, 'messages', 1).catch(() => {});

    if (input.channel !== 'email') {
      await persistEnvelope({
        clientId: input.clientId,
        contactId: contact._id,
        channel: input.channel,
        intent: input.intent,
        status: 'sent',
        reason: '',
        templateName: input?.payload?.templateName || '',
        idempotencyKey: idemKey,
        context: buildPersistContext(input, contact),
        consentSnapshot: consent.consentSnapshot || null,
        messageId: dispatchResult?.messageId || '',
        sentAt: new Date(),
      });
    } else if (preCreatedEnvelopeId) {
      await incrementEmailCount(input.clientId, 1).catch(() => {});
    }
    emitToClient(input.clientId, 'send_envelope:result', {
      contactId: String(contact._id),
      channel: input.channel,
      status: 'sent',
      messageId: dispatchResult?.messageId || null,
    });

    return buildResult('sent', {
      messageId: dispatchResult?.messageId || null,
      consentSnapshot: consent.consentSnapshot || null,
      idempotencyKey: idemKey,
      windowBucket: bucket,
    });
  } catch (err) {
    if (isRateLimitError(err)) {
      await applyRateLimitThrottle(input.clientId, input.channel).catch(() => {});
      return buildResult('blocked', {
        blockedBy: 'meta_rate',
        reason: 'platform_rate_limited',
        retryAfter: 300,
        consentSnapshot: consent.consentSnapshot || null,
      });
    }
    if (input.channel !== 'email') {
      await persistEnvelope({
        clientId: input.clientId,
        contactId: contact._id,
        channel: input.channel,
        intent: input.intent,
        status: 'failed',
        reason: err.message,
        templateName: input?.payload?.templateName || '',
        idempotencyKey: idemKey,
        context: buildPersistContext(input, contact),
        consentSnapshot: consent.consentSnapshot || null,
        failedAt: new Date(),
      });
    }
    return buildResult('failed', { reason: err.message, consentSnapshot: consent.consentSnapshot || null });
  }
}

function buildUnsubscribeToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  sendEnvelope,
  buildUnsubscribeToken,
};
