'use strict';

const Segment = require('../models/Segment');
const { SYSTEM_SEGMENT_PRESETS } = require('../constants/systemSegmentPresets');
const { flatConditionsToTree, resolveSegmentDefinition } = require('../utils/segmentConditionUtils');
const { translateConditionsToQuery } = require('../services/SegmentQueryBuilderV2');
const { syncOrderBackedCustomersToAdLeads } = require('../utils/commerce/leadsAnalyticsFacet');
const { countUnifiedSegment } = require('../services/segmentAudienceEvaluation');

async function countSegmentQuery(clientId, conditionTreeOrPayload) {
  const tree = conditionTreeOrPayload?.type === 'group'
    ? conditionTreeOrPayload
    : resolveSegmentDefinition(
        conditionTreeOrPayload?.conditionTree
          ? { conditionTree: conditionTreeOrPayload.conditionTree }
          : { conditions: conditionTreeOrPayload?.conditions || [] }
      ).conditionTree;

  const { count } = await countUnifiedSegment(clientId, tree);
  return count;
}

function buildPresetDefinition(preset) {
  if (preset.conditionTree) {
    return resolveSegmentDefinition({ conditionTree: preset.conditionTree });
  }
  return resolveSegmentDefinition({ conditions: preset.conditions || [] });
}

async function bootstrapSystemSegments(clientId) {
  if (!clientId) return { created: 0, skipped: 0, updated: 0 };

  await syncOrderBackedCustomersToAdLeads(clientId).catch(() => {});

  const existing = await Segment.find({ clientId, presetKey: { $exists: true, $ne: null } })
    .select('presetKey')
    .lean();
  const existingKeys = new Set(existing.map((s) => s.presetKey));

  let created = 0;
  let skipped = 0;
  let updated = 0;
  const now = new Date();

  for (const preset of SYSTEM_SEGMENT_PRESETS) {
    const { conditionTree, conditions } = buildPresetDefinition(preset);
    const query = translateConditionsToQuery(conditionTree);
    const lastCount = await countSegmentQuery(clientId, conditionTree);

    if (existingKeys.has(preset.presetKey)) {
      const reconcile = await Segment.updateOne(
        { clientId, presetKey: preset.presetKey, isSystem: true },
        {
          $set: {
            name: preset.name,
            description: preset.description,
            conditions,
            conditionTree,
            query,
            lastCount,
            lastCountAt: now,
            updatedAt: now,
          },
        }
      );
      if (reconcile.modifiedCount > 0) updated += 1;
      skipped += 1;
      continue;
    }

    await Segment.create({
      clientId,
      name: preset.name,
      description: preset.description,
      conditions,
      conditionTree,
      query,
      presetKey: preset.presetKey,
      isSystem: true,
      type: 'dynamic',
      lastCount,
      lastCountAt: now,
      createdAt: now,
      updatedAt: now,
    });
    created += 1;
  }

  return { created, skipped, updated };
}

module.exports = { bootstrapSystemSegments, countSegmentQuery };
