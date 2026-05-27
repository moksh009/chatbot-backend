const crypto = require('crypto');
const Client = require('../../models/Client');
const { writeAuditLog } = require('./writeAuditLog');
const { resolveChannelRateLimits, applyRateLimitThrottle, isRateLimitError } = require('./channelRateLimits');
const MessageEnvelope = require('../../models/MessageEnvelope');
const { emitToClient } = require('../core/socket');
const { getAppRedis } = require('../core/redisFactory');
const log = require('../core/logger')('SendEnvelope');
const { incrementUsage } = require('../core/planLimits');
const { generateIdempotencyKey, resolveWindowBucket } = require('./idempotency');
const { consumeTokenBucket } = require('./rateLimits');
const { sendWhatsApp, sendEmailMessage, sendInstagram } = require('./transports');
const { validateInput } = require('./checks/validateInput');
const { resolveContact } = require('./checks/resolveContact');
const { checkIdempotency } = require('./checks/checkIdempotency');
const { checkChannelEnabled } = require('./checks/checkChannelEnabled');
const { checkConsent } = require('./checks/checkConsent');
const { checkSuppression } = require('./checks/checkSuppression');
const { checkServiceWindow } = require('./checks/checkServiceWindow');
const { checkTemplateApproval } = require('./checks/checkTemplateApproval');
const { checkPlanLimit } = require('./checks/checkPlanLimit');

function buildResult(status, extra = {}) {
  return { status, ...extra };
}

async function persistEnvelope(doc) {
  try {
    await MessageEnvelope.create(doc);
  } catch (err) {
    log.warn(`MessageEnvelope persist failed: ${err.message}`);
  }
}

async function sendEnvelope(input = {}) {
  const startedAt = Date.now();
  const timings = {};
  const mark = (name, t0) => {
    timings[name] = Date.now() - t0;
  };

  const redis = getAppRedis();
  const validateT = Date.now();
  const valid = validateInput(input);
  mark('validateInput', validateT);
  if (!valid.pass) return buildResult('blocked', valid);

  const client = await Client.findOne({ clientId: input.clientId })
    .select(
      'clientId complianceConfig flags syncedMetaTemplates phoneNumberId whatsappToken instagramAccessToken igAccessToken social.instagram.accessToken name email'
    )
    .lean();
  if (!client) return buildResult('blocked', { blockedBy: 'invalid_contact', reason: 'client_not_found' });

  const resolveT = Date.now();
  const contactRes = await resolveContact(input);
  mark('resolveContact', resolveT);
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
  const idemT = Date.now();
  const idem = await checkIdempotency({ redis, key: idemKey, ttlSec: input?.idempotency?.ttlSec || ttlSec });
  mark('checkIdempotency', idemT);
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
      context: input.context || {},
    });
    return buildResult('duplicate', { blockedBy: 'idempotency', reason: idem.reason });
  }

  const channelT = Date.now();
  const channelEnabled = checkChannelEnabled({ client, channel: input.channel });
  mark('checkChannelEnabled', channelT);
  if (!channelEnabled.pass) return buildResult('blocked', channelEnabled);

  const consentT = Date.now();
  const consent = checkConsent({
    contact,
    channel: input.channel,
    intent: input.intent,
    strictMode: client?.complianceConfig?.strictMode !== false,
    complianceExempt: input?.options?.complianceExempt === true,
  });
  mark('checkConsent', consentT);
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
      context: input.context || {},
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

  const suppressionT = Date.now();
  const suppression = await checkSuppression({
    redis,
    clientId: input.clientId,
    channel: input.channel,
    contact,
  });
  mark('checkSuppression', suppressionT);
  if (!suppression.pass) return buildResult('blocked', suppression);

  const windowT = Date.now();
  const serviceWindow = checkServiceWindow({ channel: input.channel, intent: input.intent, payload: input.payload, contact });
  mark('checkServiceWindow', windowT);
  if (!serviceWindow.pass) return buildResult('blocked', serviceWindow);

  const templateT = Date.now();
  const templateCheck = await checkTemplateApproval({
    redis,
    clientId: input.clientId,
    payload: input.payload,
    intent: input.intent,
  });
  mark('checkTemplateApproval', templateT);
  if (!templateCheck.pass) return buildResult('blocked', templateCheck);

  const planT = Date.now();
  const plan = await checkPlanLimit({ clientId: input.clientId });
  mark('checkPlanLimit', planT);
  if (!plan.pass) return buildResult('blocked', plan);

  const tenantRateT = Date.now();
  const { sustainedPerSec, burst } = await resolveChannelRateLimits(client, input.channel);
  const tenantRate = await consumeTokenBucket(redis, {
    key: `${input.clientId}:${input.channel}`,
    capacity: burst,
    refillPerSec: sustainedPerSec,
  });
  mark('checkTenantRateBudget', tenantRateT);
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

  try {
    const dispatchT = Date.now();
    let dispatchResult = null;
    if (input.channel === 'email') {
      dispatchResult = await sendEmailMessage({
        client,
        to: contact.email,
        payload: input.payload,
      });
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
    mark('dispatch', dispatchT);

    await incrementUsage(input.clientId, 'messages', 1).catch(() => {});
    await persistEnvelope({
      clientId: input.clientId,
      contactId: contact._id,
      channel: input.channel,
      intent: input.intent,
      status: 'sent',
      reason: '',
      templateName: input?.payload?.templateName || '',
      idempotencyKey: idemKey,
      context: input.context || {},
      consentSnapshot: consent.consentSnapshot || null,
      messageId: dispatchResult?.messageId || '',
      sentAt: new Date(),
    });
    emitToClient(input.clientId, 'send_envelope:result', {
      contactId: String(contact._id),
      channel: input.channel,
      status: 'sent',
      messageId: dispatchResult?.messageId || null,
    });

    const total = Date.now() - startedAt;
    if (total > 50) {
      log.warn('Slow envelope execution', { ms: total, timings, clientId: input.clientId, channel: input.channel });
    }
    return buildResult('sent', {
      messageId: dispatchResult?.messageId || null,
      consentSnapshot: consent.consentSnapshot || null,
      idempotencyKey: idemKey,
      timings,
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
    await persistEnvelope({
      clientId: input.clientId,
      contactId: contact._id,
      channel: input.channel,
      intent: input.intent,
      status: 'failed',
      reason: err.message,
      templateName: input?.payload?.templateName || '',
      idempotencyKey: idemKey,
      context: input.context || {},
      consentSnapshot: consent.consentSnapshot || null,
      failedAt: new Date(),
    });
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
