'use strict';

const MessageEnvelope = require('../../models/MessageEnvelope');
const { sendWorkspaceEmailDirect } = require('./emailService');
const { prepareTrackedEmailHtml } = require('./emailTrackingService');
const { checkEmailDailyLimit, incrementEmailCount } = require('./emailRateLimiter');

/**
 * Send workspace email with tracking pixel, click wrap, unsubscribe footer, and envelope record.
 */
async function dispatchTrackedEmail({
  client,
  clientId,
  to,
  subject,
  html,
  text,
  format = 'html',
  intent = 'marketing',
  contactId = null,
  context = {},
  idempotencyKey,
  templateName = '',
  consentSnapshot = null,
  skipRateLimit = false,
}) {
  const cid = clientId || client?.clientId;
  const recipient = String(to || '').trim().toLowerCase();
  if (!recipient) {
    const err = new Error('Recipient email is required.');
    err.status = 400;
    throw err;
  }

  if (!skipRateLimit) {
    const rateCheck = await checkEmailDailyLimit(cid, 1);
    if (!rateCheck.allowed) {
      const err = new Error(
        `Daily email limit reached (${rateCheck.sent || rateCheck.limit}/${rateCheck.limit} sent today). Try again tomorrow.`
      );
      err.code = 'daily_limit_reached';
      err.status = 429;
      err.remaining = rateCheck.remaining;
      err.limit = rateCheck.limit;
      throw err;
    }
  }

  const key =
    idempotencyKey ||
    `tracked:${cid}:${recipient}:${String(subject || '').slice(0, 40)}:${Date.now()}`;

  const envelope = await MessageEnvelope.create({
    clientId: cid,
    contactId: contactId || undefined,
    channel: 'email',
    intent,
    status: 'queued',
    templateName: templateName || subject || '',
    idempotencyKey: key,
    context: { ...context, subject, recipientEmail: recipient },
    consentSnapshot,
  });

  const trackedHtml = prepareTrackedEmailHtml({
    html,
    envelopeId: envelope._id,
    clientId: cid,
    leadId: contactId,
    storeName: client?.name || client?.businessName || 'Your store',
    intent,
  });

  const sendOut = await sendWorkspaceEmailDirect(client, {
    to: recipient,
    subject,
    html: trackedHtml,
    text,
    format,
  });

  if (!sendOut.success) {
    const { isHardBounceError, markEmailBounced } = require('./emailBounceHandler');
    const hardBounce = isHardBounceError(sendOut.error);
    if (hardBounce) {
      await markEmailBounced({
        clientId: cid,
        email: recipient,
        hardBounce: true,
        source: 'tracked_send',
        contactId,
        envelopeId: envelope._id,
        bounceReason: sendOut.error,
      }).catch(() => {});
    } else {
      await MessageEnvelope.updateOne(
        { _id: envelope._id },
        { status: 'failed', reason: sendOut.error || 'send_failed', failedAt: new Date() }
      );
    }
    const err = new Error(sendOut.error || 'Email send failed');
    err.status = sendOut.revoked ? 401 : 502;
    err.code = sendOut.revoked ? 'gmail_auth_revoked' : undefined;
    throw err;
  }

  // Persist sent status before rate-limit bookkeeping — email is already delivered.
  await MessageEnvelope.updateOne(
    { _id: envelope._id },
    { status: 'sent', sentAt: new Date(), messageId: sendOut.messageId || '' }
  );

  if (!skipRateLimit) {
    await incrementEmailCount(cid, 1);
  }

  return {
    success: true,
    envelopeId: envelope._id,
    messageId: sendOut.messageId || null,
  };
}

module.exports = { dispatchTrackedEmail };
