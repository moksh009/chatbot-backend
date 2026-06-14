'use strict';

const AdLead = require('../../models/AdLead');
const MessageEnvelope = require('../../models/MessageEnvelope');
const EmailTracking = require('../../models/EmailTracking');

function normalizeRecipientEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

/**
 * Detect permanent / hard bounce signals from Gmail API or SMTP errors.
 */
function isHardBounceError(message = '', code = null) {
  const msg = String(message || '');
  const numericCode = Number(code);
  if (numericCode === 550 || numericCode === 551 || numericCode === 553) return true;
  return (
    /user not found/i.test(msg) ||
    /invalid recipient/i.test(msg) ||
    /address rejected/i.test(msg) ||
    /mailbox unavailable/i.test(msg) ||
    /no such user/i.test(msg) ||
    /recipient address rejected/i.test(msg) ||
    /\b550\b/.test(msg) ||
    /\b551\b/.test(msg) ||
    /\b553\b/.test(msg)
  );
}

/**
 * Mark a lead email as bounced (tenant-scoped when clientId provided).
 */
async function markEmailBounced({
  clientId = null,
  email,
  hardBounce = true,
  source = 'send_failure',
  contactId = null,
  envelopeId = null,
  bounceReason = '',
} = {}) {
  const normalized = normalizeRecipientEmail(email);
  if (!normalized || !normalized.includes('@')) {
    return { matched: 0, updated: false };
  }

  if (!clientId) {
    console.warn('[emailBounceHandler] skip bounce mark — clientId required for tenant scope');
    return { matched: 0, updated: false, skipped: true };
  }

  const now = new Date();
  const leadFilter = { clientId, email: normalized };
  if (contactId) {
    leadFilter._id = contactId;
  }

  const update = {
    $set: {
      emailBounced: true,
      emailBouncedAt: now,
      ...(hardBounce ? { emailHardBounce: true } : {}),
    },
  };

  const result = await AdLead.updateMany(leadFilter, update);

  if (envelopeId) {
    await MessageEnvelope.updateOne(
      { _id: envelopeId, ...(clientId ? { clientId } : {}) },
      {
        $set: {
          status: 'failed',
          reason: 'email_bounced',
          failedAt: now,
          'tracking.bounced': true,
          'tracking.bouncedAt': now,
        },
      }
    ).catch(() => {});
  }

  if (clientId && (result.modifiedCount > 0 || result.matchedCount > 0)) {
    try {
      await EmailTracking.create({
        clientId,
        leadId: contactId || null,
        envelopeId: envelopeId || null,
        type: 'bounce',
        url: '',
        ipAddress: '',
        userAgent: String(bounceReason || source || 'bounce').slice(0, 500),
        timestamp: now,
      });
    } catch (_) {
      /* non-fatal */
    }
  }

  return {
    matched: result.matchedCount || 0,
    updated: (result.modifiedCount || 0) > 0,
  };
}

/**
 * Resend (or compatible) webhook: `{ type: "email.bounced", data: { to: "..." } }`
 */
async function handleResendBounceWebhook(body = {}) {
  const eventType = String(body.type || body.event || '').toLowerCase();
  if (eventType !== 'email.bounced') return false;

  const data = body.data || body;
  const clientId = data.clientId || body.clientId || data.metadata?.clientId || null;
  if (!clientId) {
    console.warn('[emailBounceHandler] Resend bounce webhook missing clientId — skipped');
    return false;
  }

  const recipients = [];
  if (Array.isArray(data.to)) recipients.push(...data.to);
  else if (data.to) recipients.push(data.to);
  else if (data.email) recipients.push(data.email);

  const reason = data.bounce?.message || data.reason || 'resend_bounce';

  for (const raw of recipients) {
    await markEmailBounced({
      clientId,
      email: raw,
      hardBounce: true,
      source: 'resend_webhook',
      bounceReason: reason,
    });
  }

  return recipients.length > 0 && !!clientId;
}

module.exports = {
  isHardBounceError,
  markEmailBounced,
  handleResendBounceWebhook,
  normalizeRecipientEmail,
};
