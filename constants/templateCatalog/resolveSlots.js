"use strict";

const MetaTemplate = require("../../models/MetaTemplate");
const {
  getCatalogGroups,
  expandSlotLookupNames,
} = require("./catalog");

function normalizeSlotStatus(rawStatus) {
  const value = String(rawStatus || "").toUpperCase();
  if (value === "APPROVED") return "APPROVED";
  if (value === "REJECTED") return "REJECTED";
  if (value === "QUEUED") return "QUEUED";
  if (value === "SUBMITTING") return "SUBMITTING";
  if (value === "PENDING_META_REVIEW" || value === "PENDING" || value === "PENDING_REVIEW") {
    return "PENDING";
  }
  if (value === "SUBMISSION_FAILED" || value === "GENERATION_FAILED" || value === "FAILED") {
    return "FAILED";
  }
  return "DRAFT";
}

function indexSyncedLibrary(syncedTemplates = []) {
  const byName = new Map();
  for (const t of syncedTemplates) {
    const name = String(t?.name || "");
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, t);
  }
  return byName;
}

function indexMetaTemplates(metaDocs = []) {
  const byName = new Map();
  for (const doc of metaDocs) {
    const name = String(doc?.name || "");
    if (!name) continue;
    const existing = byName.get(name);
    if (!existing || new Date(doc.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
      byName.set(name, doc);
    }
  }
  return byName;
}

function resolveSlotFromLibrary(slot, syncedByName, metaByName) {
  const lookupNames = expandSlotLookupNames(slot);
  let matched = null;
  let matchedName = null;
  let metaDoc = null;

  for (const n of slot.metaNames || []) {
    const hit = syncedByName.get(n);
    if (hit) {
      matched = hit;
      matchedName = n;
      metaDoc = metaByName.get(n) || null;
      break;
    }
  }

  if (!matched) {
    for (const n of lookupNames) {
      const hit = syncedByName.get(n);
      if (hit) {
        matched = hit;
        matchedName = n;
        metaDoc = metaByName.get(n) || null;
        break;
      }
    }
  }

  if (!metaDoc && matchedName) {
    metaDoc = metaByName.get(matchedName) || null;
  }
  if (!metaDoc) {
    for (const n of lookupNames) {
      const doc = metaByName.get(n);
      if (doc) {
        metaDoc = doc;
        if (!matched) {
          matched = {
            name: doc.name,
            status: doc.submissionStatus,
            category: doc.category,
            language: doc.language,
            components: doc.components,
            id: doc._id?.toString?.() || doc.metaTemplateId,
          };
          matchedName = doc.name;
        }
        break;
      }
    }
  }

  const rawStatus = matched
    ? matched.status || matched.submissionStatus
    : metaDoc?.submissionStatus;
  const status = matched || metaDoc ? normalizeSlotStatus(rawStatus) : "MISSING";

  const duplicates = (slot.metaNames || []).filter(
    (n) => n !== matchedName && syncedByName.has(n)
  );

  const templatePayload = matched
    ? {
        id: matched.id || metaDoc?._id?.toString?.() || matched.name,
        name: matched.name,
        status: matched.status || matched.submissionStatus,
        submissionStatus: matched.submissionStatus || matched.status,
        category: matched.category,
        language: matched.language,
        components: matched.components,
      }
    : metaDoc
      ? {
          id: metaDoc._id?.toString?.() || metaDoc.metaTemplateId || metaDoc.name,
          name: metaDoc.name,
          status: metaDoc.submissionStatus,
          submissionStatus: metaDoc.submissionStatus,
          category: metaDoc.category,
          language: metaDoc.language,
          components: metaDoc.components,
        }
      : null;

  return {
    slot: {
      id: slot.id,
      title: slot.title,
      description: slot.description,
      canonicalMetaName: slot.canonicalMetaName,
      metaNames: slot.metaNames,
      usedIn: slot.usedIn,
      configureRoute: slot.configureRoute,
      pack: slot.pack,
      pushKind: slot.pushKind,
      pushFromStandard: !!slot.pushFromStandard,
      prebuiltKey: slot.prebuiltKey || null,
      autoTrigger: slot.autoTrigger || null,
    },
    template: templatePayload,
    activeMetaName: matchedName || slot.canonicalMetaName || (slot.metaNames || [])[0],
    status,
    duplicates,
    isApproved: status === "APPROVED",
    isMissing: !matched && !metaDoc,
    needsPush: (!matched && !metaDoc) || status === "DRAFT" || status === "FAILED",
    metaTemplateId: metaDoc?.metaTemplateId || null,
    metaTemplateDocId: metaDoc?._id?.toString?.() || null,
  };
}

function summarizeRows(rows) {
  const total = rows.length;
  const approved = rows.filter((r) => r.isApproved).length;
  const missing = rows.filter((r) => r.isMissing).length;
  const attention = rows.filter(
    (r) => !r.isMissing && !r.isApproved && r.status !== "PENDING"
  ).length;
  const pending = rows.filter((r) => r.status === "PENDING").length;
  return { total, approved, missing, attention, pending };
}

/**
 * Server-side slot resolution for a tenant.
 * @param {string} clientId
 * @param {object} opts
 * @param {Array} [opts.syncedTemplates] — client.syncedMetaTemplates (optional; loaded if omitted)
 * @param {boolean} [opts.loadMetaDocs=true]
 */
async function resolveSlotsForClient(clientId, opts = {}) {
  let synced = opts.syncedTemplates;
  let metaDocs = opts.metaDocs;

  if (!synced || !metaDocs) {
    const Client = require("../../models/Client");
    const client = await Client.findOne({ clientId })
      .select("syncedMetaTemplates")
      .lean();
    synced = synced || client?.syncedMetaTemplates || [];
    if (opts.loadMetaDocs !== false && !metaDocs) {
      metaDocs = await MetaTemplate.find({ clientId })
        .select(
          "name templateKey submissionStatus category language components metaTemplateId updatedAt"
        )
        .sort({ updatedAt: -1 })
        .lean();
    }
  }

  const syncedByName = indexSyncedLibrary(synced);
  const metaByName = indexMetaTemplates(metaDocs || []);

  const groups = getCatalogGroups().map((group) => {
    const rows = (group.slots || []).map((slot) =>
      resolveSlotFromLibrary(slot, syncedByName, metaByName)
    );
    return {
      id: group.id,
      label: group.label,
      description: group.description,
      rows,
    };
  });

  const flatRows = groups.flatMap((g) => g.rows);
  return {
    groups,
    flatRows,
    summary: summarizeRows(flatRows),
  };
}

module.exports = {
  resolveSlotsForClient,
  resolveSlotFromLibrary,
  normalizeSlotStatus,
  summarizeRows,
};
