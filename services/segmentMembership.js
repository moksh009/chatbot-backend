'use strict';

const Segment = require('../../models/Segment');
const AdLead = require('../../models/AdLead');

/**
 * Check whether a lead matches an Audience Hub saved segment.
 */
async function leadMatchesAudienceSegment(clientId, lead, segmentId) {
  if (!clientId || !segmentId || !lead?._id) return false;

  const segment = await Segment.findOne({ _id: segmentId, clientId }).select('query').lean();
  if (!segment?.query || typeof segment.query !== 'object') return false;

  const count = await AdLead.countDocuments({
    _id: lead._id,
    clientId,
    ...segment.query,
  });
  return count > 0;
}

module.exports = {
  leadMatchesAudienceSegment,
};
