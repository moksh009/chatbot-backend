'use strict';

const MetaAudienceQueue = require('../models/MetaAudienceQueue');

/**
 * Push a saved audience to Meta Custom Audiences.
 * Placeholder until Meta Ads OAuth ships.
 */
async function pushAudienceToMeta(audienceQueueId, clientId) {
  const doc = await MetaAudienceQueue.findOne({ _id: audienceQueueId, clientId }).lean();
  if (!doc) {
    return { success: false, status: 'not_found', message: 'Audience not found' };
  }
  if (doc.status === 'expired') {
    return { success: false, status: 'expired', message: 'Audience expired — save again' };
  }

  return {
    success: false,
    status: 'not_connected',
    message: 'Meta Ads connection is not available yet. Audience saved for future push.',
    metaCustomAudienceId: null,
  };
}

module.exports = { pushAudienceToMeta };
