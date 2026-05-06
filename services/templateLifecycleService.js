"use strict";

const MetaTemplate = require("../models/MetaTemplate");
const Client = require("../models/Client");
const {
  PREBUILT_REQUIRED_TEMPLATES,
  NORMALIZED_LIFECYCLE_STATUS,
  normalizeTemplateStatus
} = require("../constants/templateLifecycle");

function buildStateCounts(items) {
  return items.reduce((acc, item) => {
    const key = item.normalizedStatus || NORMALIZED_LIFECYCLE_STATUS.DRAFT;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function evaluateReadiness(requiredItems) {
  const blockers = [];
  for (const item of requiredItems) {
    if (item.normalizedStatus !== NORMALIZED_LIFECYCLE_STATUS.APPROVED) {
      blockers.push({
        key: item.key,
        reason: `Template ${item.key} is ${item.normalizedStatus}`,
        action: item.normalizedStatus === NORMALIZED_LIFECYCLE_STATUS.FAILED ? "edit_and_retry" : "submit_or_wait"
      });
    }
  }
  return blockers;
}

async function migrateLegacyClientTemplatesToMeta(clientId) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) return { migrated: 0, total: 0 };

  const messageTemplates = Array.isArray(client.messageTemplates) ? client.messageTemplates : [];
  const pendingTemplates = Array.isArray(client.pendingTemplates) ? client.pendingTemplates : [];
  const syncedTemplates = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  const pendingMap = new Map(pendingTemplates.map((tpl) => [tpl.name, tpl]));
  const syncedMap = new Map(syncedTemplates.map((tpl) => [tpl.name, tpl]));

  let migrated = 0;
  for (const tpl of messageTemplates) {
    if (!tpl?.name) continue;
    const pending = pendingMap.get(tpl.name);
    const synced = syncedMap.get(tpl.name);
    const status = String(synced?.status || pending?.status || tpl.status || "draft").toLowerCase();
    const isRequiredPrebuilt = PREBUILT_REQUIRED_TEMPLATES.includes(tpl.name);
    const templateKind = String(tpl.name).startsWith("prod_") ? "product" : (isRequiredPrebuilt ? "prebuilt" : "custom");

    const update = await MetaTemplate.findOneAndUpdate(
      { clientId, name: tpl.name },
      {
        $set: {
          clientId,
          name: tpl.name,
          category: tpl.category || "MARKETING",
          language: tpl.language || "en",
          source: "migrated_legacy",
          templateKey: tpl.name,
          templateKind,
          readinessRequired: isRequiredPrebuilt || templateKind === "product",
          body: tpl.body || tpl.components?.find((c) => c.type === "BODY")?.text || "Template content pending sync",
          headerType: tpl.components?.find((c) => c.type === "HEADER")?.format || "TEXT",
          headerValue: tpl.components?.find((c) => c.type === "HEADER")?.text || "",
          footerText: tpl.components?.find((c) => c.type === "FOOTER")?.text || null,
          buttons: tpl.components?.find((c) => c.type === "BUTTONS")?.buttons || [],
          submissionStatus: status,
          metaTemplateId: pending?.metaId || synced?.id || tpl.id || null,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true, new: true }
    );
    if (update) migrated += 1;
  }

  return { migrated, total: messageTemplates.length };
}

async function getTemplateReadiness(clientId) {
  const templates = await MetaTemplate.find({ clientId }).lean();
  const enriched = templates.map((tpl) => ({
    ...tpl,
    normalizedStatus: normalizeTemplateStatus(tpl.submissionStatus)
  }));

  const requiredPrebuilt = PREBUILT_REQUIRED_TEMPLATES.map((key) => {
    const hit = enriched.find((tpl) => tpl.templateKey === key || tpl.name === key);
    return {
      key,
      type: "prebuilt",
      normalizedStatus: hit ? hit.normalizedStatus : NORMALIZED_LIFECYCLE_STATUS.DRAFT,
      templateId: hit?._id || null,
      name: hit?.name || key
    };
  });

  const requiredProduct = enriched
    .filter((tpl) => tpl.templateKind === "product" || tpl.readinessRequired === true && String(tpl.name || "").startsWith("prod_"))
    .map((tpl) => ({
      key: tpl.templateKey || tpl.name,
      type: "product",
      normalizedStatus: tpl.normalizedStatus,
      templateId: tpl._id,
      name: tpl.name,
      productHandle: tpl.productHandle || "",
      productName: tpl.productName || ""
    }));

  const requiredItems = [...requiredPrebuilt, ...requiredProduct];
  const blockers = evaluateReadiness(requiredItems);
  const counts = buildStateCounts(requiredItems);
  const approvedRequired = requiredItems.filter((item) => item.normalizedStatus === NORMALIZED_LIFECYCLE_STATUS.APPROVED).length;

  return {
    requiredItems,
    counts,
    blockers,
    totalRequired: requiredItems.length,
    approvedRequired,
    readinessPercent: requiredItems.length ? Math.round((approvedRequired / requiredItems.length) * 100) : 0,
    ready: blockers.length === 0
  };
}

module.exports = {
  getTemplateReadiness,
  migrateLegacyClientTemplatesToMeta
};
