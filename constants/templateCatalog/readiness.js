"use strict";

const {
  getFeatureReadinessDefinitions,
  getCatalogVersion,
  getSlotById,
} = require("./catalog");
const { resolveSlotsForClient, summarizeRows } = require("./resolveSlots");
const { getTemplateReadiness } = require("../../services/templateLifecycleService");
const { NORMALIZED_LIFECYCLE_STATUS } = require("../templateLifecycle");

function levelFromSlots(slots) {
  if (!slots.length) return "green";
  const approved = slots.filter((s) => s.isApproved).length;
  if (approved === slots.length) return "green";
  const missing = slots.filter((s) => s.isMissing).length;
  if (missing === slots.length) return "red";
  return "yellow";
}

function levelLabel(level) {
  if (level === "green") return "Ready";
  if (level === "yellow") return "In progress";
  return "Action needed";
}

/**
 * Unified feature readiness from catalog slots + tenant resolution.
 */
async function getUnifiedTemplateReadiness(clientId, opts = {}) {
  const synced = opts.syncedTemplates;
  const resolved = await resolveSlotsForClient(clientId, {
    syncedTemplates: synced,
    loadMetaDocs: true,
  });

  const rowBySlotId = new Map(resolved.flatRows.map((r) => [r.slot.id, r]));

  const features = getFeatureReadinessDefinitions().map((def) => {
    const slotRows = (def.slotIds || [])
      .map((id) => rowBySlotId.get(id))
      .filter(Boolean);
    const level = levelFromSlots(slotRows);
    const approved = slotRows.filter((r) => r.isApproved).length;
    const total = slotRows.length;

    return {
      id: def.id,
      label: def.label,
      description: def.description,
      configureRoute: def.configureRoute,
      level,
      levelLabel: levelLabel(level),
      ready: level === "green",
      approved,
      total,
      slots: slotRows.map((r) => ({
        slotId: r.slot.id,
        title: r.slot.title,
        activeMetaName: r.activeMetaName,
        status: r.status,
        isApproved: r.isApproved,
        isMissing: r.isMissing,
        metaTemplateId: r.metaTemplateId,
        metaTemplateDocId: r.metaTemplateDocId,
        configureRoute: r.slot.configureRoute || def.configureRoute,
      })),
    };
  });

  const slotSummary = summarizeRows(resolved.flatRows);
  const levelCounts = { green: 0, yellow: 0, red: 0 };
  for (const f of features) levelCounts[f.level] = (levelCounts[f.level] || 0) + 1;

  let wizardPack = null;
  try {
    wizardPack = await getTemplateReadiness(clientId);
  } catch {
    wizardPack = null;
  }

  return {
    catalogVersion: getCatalogVersion(),
    clientId,
    slotSummary,
    features,
    featureLevelCounts: levelCounts,
    allFeaturesReady: features.length > 0 && features.every((f) => f.ready),
    wizardPack,
    groups: resolved.groups,
  };
}

/** Lookup readiness for a single catalog slot id. */
function getSlotReadinessFromPayload(payload, slotId) {
  if (!payload?.features) return null;
  for (const feature of payload.features) {
    const hit = feature.slots?.find((s) => s.slotId === slotId);
    if (hit) return { feature, slot: hit };
  }
  const slot = getSlotById(slotId);
  return slot ? { feature: null, slot: { slotId, title: slot.title, status: "MISSING" } } : null;
}

module.exports = {
  getUnifiedTemplateReadiness,
  getSlotReadinessFromPayload,
  levelFromSlots,
  levelLabel,
};
