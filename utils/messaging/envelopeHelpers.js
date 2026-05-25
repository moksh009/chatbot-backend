const { sendEnvelope } = require('./sendEnvelope');
const log = require('../core/logger')('EnvelopeHelpers');

/**
 * Phase 2 Slice 7 — envelope is always on for customer outbound.
 * `Client.flags.useSendEnvelope` and `FORCE_SEND_ENVELOPE` are deprecated.
 */
function shouldUseSendEnvelope(_client) {
  return true;
}

function intentFromTemplateCategory(category) {
  const cat = String(category || 'MARKETING').toUpperCase();
  if (cat === 'UTILITY' || cat === 'AUTHENTICATION') return 'utility';
  if (cat === 'TRANSACTIONAL') return 'transactional';
  return 'marketing';
}

/**
 * Normalize sendEnvelope result for cron/campaign callers.
 */
function interpretEnvelopeResult(result, logger = log) {
  if (!result) return { action: 'failed', reason: 'no_result' };
  if (result.status === 'sent' || result.status === 'queued') {
    return { action: 'sent', messageId: result.messageId, result };
  }
  if (result.status === 'duplicate') {
    logger.debug?.('Envelope duplicate — skip send');
    return { action: 'duplicate', result };
  }
  if (result.blockedBy === 'rate_limit' || (result.status === 'blocked' && result.retryAfter)) {
    return { action: 'rate_limit', retryAfter: result.retryAfter || 60, result };
  }
  if (result.status === 'blocked') {
    return {
      action: 'skipped',
      reason: result.reason || result.blockedBy || 'blocked',
      result,
    };
  }
  if (result.status === 'failed') {
    return { action: 'failed', reason: result.reason || 'send_failed', result };
  }
  return { action: 'failed', reason: result.status, result };
}

async function dispatchViaEnvelope(client, envelopeInput) {
  const result = await sendEnvelope(envelopeInput);
  return interpretEnvelopeResult(result);
}

module.exports = {
  shouldUseSendEnvelope,
  intentFromTemplateCategory,
  interpretEnvelopeResult,
  dispatchViaEnvelope,
  sendEnvelope,
};
