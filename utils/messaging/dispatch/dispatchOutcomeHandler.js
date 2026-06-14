const RETRY_DELAYS_SEC = [0, 30, 120, 600, 1800];
const MAX_ATTEMPTS = 5;

const PERMANENT_BLOCKS = new Set([
  'consent',
  'suppression',
  'plan_limit',
  'template_not_approved',
  'channel_disabled',
  'invalid_contact',
  'email_credentials',
  'whatsapp_credentials',
]);

const CONSENT_BLOCKS = new Set(['consent', 'suppression']);

const EMAIL_SKIP_REASONS = new Set([
  'email_opted_out',
  'email_bounced',
  'recipient_opted_out',
]);

function nextAttemptDelaySec(attempts) {
  const idx = Math.min(Math.max(attempts, 1), RETRY_DELAYS_SEC.length) - 1;
  return RETRY_DELAYS_SEC[idx];
}

/**
 * Map sendEnvelope / interpretEnvelopeResult to dispatch action for workers.
 */
function classifyEnvelopeOutcome(result, attempts = 0) {
  if (!result) return { action: 'failed', permanent: true, reason: 'no_result' };
  if (result.status === 'sent' || result.status === 'queued') {
    return { action: 'sent', messageId: result.messageId };
  }
  if (result.status === 'duplicate') {
    return { action: 'sent', duplicate: true, recoveredFromDuplicate: true };
  }
  const blockedBy = result.blockedBy || result.reason;
  if (result.status === 'blocked' && result.blockedBy === 'consent' && EMAIL_SKIP_REASONS.has(result.reason)) {
    return { action: 'skipped', reason: result.reason };
  }
  if (result.blockedBy === 'rate_limit' || result.retryAfter) {
    if (attempts >= MAX_ATTEMPTS) {
      return { action: 'failed', permanent: true, reason: 'max_retries_rate_limit' };
    }
    return {
      action: 'retry',
      delaySec: Number(result.retryAfter || nextAttemptDelaySec(attempts + 1)),
      reason: 'rate_limit',
    };
  }
  if (CONSENT_BLOCKS.has(blockedBy)) {
    return { action: 'cancelled', reason: blockedBy, cancelledReason: blockedBy };
  }
  if (PERMANENT_BLOCKS.has(blockedBy)) {
    return { action: 'failed', permanent: true, reason: blockedBy };
  }
  if (blockedBy === 'template_not_approved' && attempts < 3) {
    return { action: 'retry', delaySec: nextAttemptDelaySec(attempts + 1), reason: blockedBy };
  }
  if (attempts >= MAX_ATTEMPTS) {
    return { action: 'failed', permanent: true, reason: result.reason || blockedBy || 'max_retries' };
  }
  return { action: 'retry', delaySec: nextAttemptDelaySec(attempts + 1), reason: result.reason || blockedBy };
}

module.exports = {
  classifyEnvelopeOutcome,
  RETRY_DELAYS_SEC,
  MAX_ATTEMPTS,
};
