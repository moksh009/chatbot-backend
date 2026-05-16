"use strict";

const MetaTemplate = require("../models/MetaTemplate");

/**
 * Resolve a template reference (id or name) — MetaTemplate first, then legacy Client.messageTemplates.
 */
async function resolveClientTemplate(client, { id, name, templateName } = {}) {
  const clientId = client?.clientId;
  const lookupName = templateName || name;

  if (clientId && (id || lookupName)) {
    const query = id
      ? { clientId, $or: [{ _id: id }, { templateKey: id }, { name: id }] }
      : { clientId, $or: [{ name: lookupName }, { templateKey: lookupName }] };
    const meta = await MetaTemplate.findOne(query).lean();
    if (meta) {
      return {
        id: meta._id?.toString(),
        name: meta.name,
        templateName: meta.name,
        status: meta.submissionStatus,
        language: meta.language || "en",
        source: "meta_template",
      };
    }
  }

  const legacyList = Array.isArray(client?.messageTemplates) ? client.messageTemplates : [];
  const legacy = legacyList.find(
    (t) => t.id === id || t.name === lookupName || t.templateName === lookupName
  );
  if (legacy) {
    return {
      id: legacy.id,
      name: legacy.name,
      templateName: legacy.templateName || legacy.name,
      status: legacy.status,
      language: legacy.language || "en",
      source: "message_templates",
    };
  }

  if (lookupName && Array.isArray(client?.syncedMetaTemplates)) {
    const synced = client.syncedMetaTemplates.find((t) => t.name === lookupName);
    if (synced) {
      return {
        id: synced.id,
        name: synced.name,
        templateName: synced.name,
        status: synced.status,
        language: synced.language || "en",
        source: "synced_meta",
      };
    }
  }

  return null;
}

module.exports = { resolveClientTemplate };
