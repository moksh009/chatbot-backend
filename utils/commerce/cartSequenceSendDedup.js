'use strict';

const FollowUpSequence = require('../../models/FollowUpSequence');

/**
 * Skip cart recovery send when lead has an active marketing sequence with pending steps (Phase 7).
 */
async function hasPendingMarketingSequenceSend(clientId, leadId) {
  if (!clientId || !leadId) return false;

  const now = new Date();
  const seq = await FollowUpSequence.findOne({
    clientId,
    leadId,
    status: 'active',
    type: { $ne: 'abandoned_cart' },
    steps: {
      $elemMatch: {
        status: { $in: ['pending', 'queued', 'processing', 'retrying'] },
        sendAt: { $lte: new Date(now.getTime() + 6 * 60 * 60 * 1000) },
      },
    },
  })
    .select('_id name type')
    .lean();

  return !!seq;
}

module.exports = { hasPendingMarketingSequenceSend };
