"use strict";

const Client = require("../models/Client");
const MetaTemplate = require("../models/MetaTemplate");
const { getPrebuiltByKey, PREBUILT_TEMPLATE_LIBRARY } = require("../constants/prebuiltTemplateLibrary");

const APPROVED_STATUSES = new Set(["approved"]);

function normalizeStatus(s) {
  return String(s || "").toLowerCase();
}

function isSendableMeta(doc) {
  if (!doc) return false;
  const st = normalizeStatus(doc.submissionStatus);
  return APPROVED_STATUSES.has(st) || st === "approved";
}

/**
 * Prefer MetaTemplate collection, then synced Meta list, then legacy messageTemplates.
 */
async function findMetaTemplate(clientId, { trigger, name, templateKey, autoTrigger } = {}) {
  const trig = autoTrigger || trigger;
  if (trig) {
    const byTrigger = await MetaTemplate.findOne({
      clientId,
      autoTrigger: trig,
      isActive: { $ne: false },
      submissionStatus: "approved",
    })
      .sort({ isPrebuilt: -1, updatedAt: -1 })
      .lean();
    if (byTrigger) return { source: "meta_template", template: byTrigger };
  }

  const key = templateKey || name;
  if (key) {
    const byKey = await MetaTemplate.findOne({
      clientId,
      $or: [{ name: key }, { templateKey: key }, { metaTemplateId: key }],
    })
      .sort({ updatedAt: -1 })
      .lean();
    if (byKey) return { source: "meta_template", template: byKey };

    const prebuilt = getPrebuiltByKey(key);
    if (prebuilt) {
      const byPrebuilt = await MetaTemplate.findOne({
        clientId,
        $or: [{ templateKey: prebuilt.key }, { name: prebuilt.metaName }],
      })
        .sort({ updatedAt: -1 })
        .lean();
      if (byPrebuilt) return { source: "meta_template", template: byPrebuilt };
    }
  }

  return { source: null, template: null };
}

async function findLegacyTemplate(client, name) {
  if (!client || !name) return null;
  const synced = (client.syncedMetaTemplates || []).find((t) => t.name === name);
  if (synced) {
    return {
      source: "synced_meta",
      template: {
        name: synced.name,
        metaTemplateName: synced.name,
        language: synced.language || "en",
        submissionStatus: normalizeStatus(synced.status) === "approved" ? "approved" : "approved",
        variableMappings: synced.variableMappings || null,
        components: synced.components,
      },
    };
  }

  const local = (client.messageTemplates || []).find((t) => t.name === name || t.id === name);
  if (local) {
    return {
      source: "message_templates",
      template: {
        name: local.name,
        metaTemplateName: local.name,
        language: local.language || "en",
        submissionStatus: normalizeStatus(local.status),
        body: local.body,
        variableMapping: local.variableMapping || {},
      },
    };
  }

  return null;
}

/**
 * Resolve a sendable template: MetaTemplate → synced → legacy → prebuilt definition (draft).
 */
async function resolveTemplateForSend(clientId, { trigger, name, templateKey } = {}) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) return null;

  const metaHit = await findMetaTemplate(clientId, { trigger, name, templateKey });
  if (metaHit.template && isSendableMeta(metaHit.template)) {
    return { client, ...metaHit };
  }

  const lookupName = name || templateKey;
  if (lookupName) {
    const legacy = await findLegacyTemplate(client, lookupName);
    if (legacy?.template && legacy.template.submissionStatus !== "rejected") {
      return { client, ...legacy };
    }
  }

  if (trigger) {
    const prebuilt = PREBUILT_TEMPLATE_LIBRARY.find((p) => p.autoTrigger === trigger);
    if (prebuilt) {
      const again = await findMetaTemplate(clientId, { name: prebuilt.metaName, templateKey: prebuilt.key });
      if (again.template) return { client, ...again, prebuilt };
      const nicheName =
        client.nicheData?.orderStatusTemplates?.[trigger.replace("order_", "")] ||
        client.nicheData?.[`${trigger}_template`];
      if (nicheName) {
        const nicheResolved = await resolveTemplateForSend(clientId, { name: nicheName });
        if (nicheResolved) return nicheResolved;
      }
      return {
        client,
        source: "prebuilt_definition",
        prebuilt,
        template: {
          name: prebuilt.metaName,
          metaTemplateName: prebuilt.metaName,
          body: prebuilt.bodyText,
          category: prebuilt.category,
          variableMappings: prebuilt.variableMappings,
          submissionStatus: "draft",
          isPrebuilt: true,
        },
      };
    }
  }

  if (metaHit.template) return { client, ...metaHit };
  return null;
}

/**
 * List template names for a client (MetaTemplate first, de-duped with legacy).
 */
async function listClientTemplateNames(clientId) {
  const [meta, client] = await Promise.all([
    MetaTemplate.find({ clientId }).select("name templateKey submissionStatus autoTrigger").lean(),
    Client.findOne({ clientId }).select("messageTemplates syncedMetaTemplates").lean(),
  ]);
  const names = new Map();
  for (const m of meta) {
    names.set(m.name, { name: m.name, source: "meta_template", status: m.submissionStatus, autoTrigger: m.autoTrigger });
  }
  for (const t of client?.syncedMetaTemplates || []) {
    if (!names.has(t.name)) names.set(t.name, { name: t.name, source: "synced_meta", status: t.status });
  }
  for (const t of client?.messageTemplates || []) {
    if (t?.name && !names.has(t.name)) {
      names.set(t.name, { name: t.name, source: "message_templates", status: t.status });
    }
  }
  return Array.from(names.values());
}

module.exports = {
  findMetaTemplate,
  findLegacyTemplate,
  resolveTemplateForSend,
  listClientTemplateNames,
  isSendableMeta,
};
