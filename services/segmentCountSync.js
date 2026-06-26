'use strict';

const Segment = require('../models/Segment');
const { syncOrderBackedCustomersToAdLeads } = require('../utils/commerce/leadsAnalyticsFacet');
const { clearClientCache } = require('../middleware/apiCache');
const { serializeSegment } = require('../utils/segmentConditionUtils');
const { translateConditionsToQuery: translateTreeQuery } = require('./SegmentQueryBuilderV2');
const { countUnifiedSegment } = require('./segmentAudienceEvaluation');

const debounceTimers = new Map();
const DEBOUNCE_MS = 45_000;

async function refreshAllSegmentCounts(clientId) {
  if (!clientId) return { updated: 0 };
  await syncOrderBackedCustomersToAdLeads(clientId).catch(() => {});
  const segments = await Segment.find({ clientId })
    .select('_id query conditionTree conditions')
    .lean();
  const now = new Date();
  let updated = 0;
  for (const seg of segments) {
    const serialized = serializeSegment(seg);
    const query = translateTreeQuery(serialized.conditionTree);
    const { count } = await countUnifiedSegment(clientId, serialized.conditionTree);
    await Segment.updateOne(
      { _id: seg._id, clientId },
      {
        $set: {
          query,
          conditionTree: serialized.conditionTree,
          conditions: serialized.conditions,
          lastCount: count,
          lastCountAt: now,
          updatedAt: now,
        },
      }
    );
    updated += 1;
  }
  await clearClientCache(clientId).catch(() => {});
  return { updated };
}

function scheduleSegmentCountRefresh(clientId) {
  if (!clientId) return;
  if (debounceTimers.has(clientId)) {
    clearTimeout(debounceTimers.get(clientId));
  }
  const timer = setTimeout(() => {
    debounceTimers.delete(clientId);
    refreshAllSegmentCounts(clientId).catch((err) => {
      console.error('[Segments] Debounced count refresh failed:', err.message);
    });
  }, DEBOUNCE_MS);
  debounceTimers.set(clientId, timer);
}

module.exports = {
  refreshAllSegmentCounts,
  scheduleSegmentCountRefresh,
};
