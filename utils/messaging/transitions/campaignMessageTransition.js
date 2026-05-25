const CampaignMessage = require('../../../models/CampaignMessage');

const ALLOWED = {
  queued: new Set(['processing', 'cancelled']),
  processing: new Set(['sent', 'retrying', 'failed', 'cancelled']),
  retrying: new Set(['processing', 'cancelled']),
  sent: new Set(['delivered', 'read', 'replied', 'failed']),
  delivered: new Set(['read', 'replied', 'failed']),
  read: new Set(['replied', 'failed']),
  replied: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

function assertTransition(fromStatus, toStatus) {
  const from = String(fromStatus || 'queued');
  const to = String(toStatus);
  const allowed = ALLOWED[from];
  if (!allowed || !allowed.has(to)) {
    const err = new Error(`invalid_campaign_message_transition:${from}->${to}`);
    err.code = 'invalid_transition';
    throw err;
  }
}

/**
 * Atomic status transition with optional patch fields.
 */
async function transitionCampaignMessage(id, fromStatus, toStatus, patch = {}) {
  assertTransition(fromStatus, toStatus);
  const filter = { _id: id, status: fromStatus };
  const $set = { status: toStatus, ...patch };
  const doc = await CampaignMessage.findOneAndUpdate(filter, { $set }, { new: true });
  if (!doc) {
    const err = new Error('campaign_message_transition_conflict');
    err.code = 'transition_conflict';
    throw err;
  }
  return doc;
}

module.exports = {
  transitionCampaignMessage,
  assertTransition,
  ALLOWED,
};
