"use strict";

const axios = require("axios");
const MetaTemplate = require("../models/MetaTemplate");
const Client = require("../models/Client");
const { decrypt } = require("../utils/core/encryption");
const log = require("../utils/core/logger")("TemplateLifecycle");
const {
  getSlotByMetaName,
  getSlotById,
  resolveCanonicalTemplateName,
} = require("../constants/templateCatalog/catalog");
const { PREBUILT_REQUIRED_TEMPLATES } = require("../constants/templateLifecycle");
const {
  parseMetaLastEdited,
  normalizeMetaCategory,
} = require("../utils/meta/metaTemplateSyncUtils");

let _emitToClient = null;
function emitToClient(clientId, event, data) {
  try {
    if (!_emitToClient) {
      const sock = require("../utils/core/socket");
      _emitToClient = sock.emitToClient || (() => {});
    }
    _emitToClient(clientId, event, data);
  } catch {
    /* socket optional */
  }
}

function mapMetaGraphStatus(raw) {
  const s = String(raw || "").toUpperCase();
  if (s === "APPROVED") return "approved";
  if (s === "REJECTED" || s === "DISABLED") return "rejected";
  if (s === "PENDING" || s === "IN_APPEAL") return "pending_meta_review";
  return "draft";
}

function syncedStatusFromSubmission(submissionStatus) {
  const st = String(submissionStatus || "").toLowerCase();
  if (st === "approved") return "APPROVED";
  if (st === "rejected") return "REJECTED";
  if (st === "pending_meta_review") return "PENDING";
  return "DRAFT";
}

function inferSourceFromSlot(slot, explicitSource) {
  if (explicitSource) return explicitSource;
  if (!slot) return "manual";
  if (slot.pushKind === "eco-standard") return "manual";
  if (slot.pushKind === "gate") return "manual";
  if (slot.pushKind === "prebuilt") return "auto_generated";
  return "manual";
}

function buildComponentsFromStandard(standardTemplate) {
  if (!standardTemplate?.components) return [];
  return standardTemplate.components;
}

/**
 * Upsert MetaTemplate + optional synced cache row after push / gate submit / seed.
 */
async function recordTemplateSubmission({
  clientId,
  metaName,
  metaTemplateId = null,
  metaStatus = "PENDING",
  components = [],
  category = "MARKETING",
  language = "en",
  source = null,
  catalogSlotId = null,
  templateKey = null,
  variableMappings = null,
  autoTrigger = null,
  isPrebuilt = false,
  body = null,
}) {
  const canonical = resolveCanonicalTemplateName(metaName);
  const resolvedSlot = catalogSlotId
    ? getSlotById(catalogSlotId)
    : getSlotByMetaName(canonical);
  const slotId = catalogSlotId || resolvedSlot?.id || null;
  const submissionStatus = mapMetaGraphStatus(metaStatus);
  const bodyComp = components.find((c) => String(c.type).toUpperCase() === "BODY");
  const headerComp = components.find((c) => String(c.type).toUpperCase() === "HEADER");
  const footerComp = components.find((c) => String(c.type).toUpperCase() === "FOOTER");
  const btnComp = components.find((c) => String(c.type).toUpperCase() === "BUTTONS");

  const update = {
    clientId,
    name: canonical,
    category: category || (resolvedSlot?.pack === "eco" ? "UTILITY" : "MARKETING"),
    language: language || "en",
    source: inferSourceFromSlot(resolvedSlot, source),
    catalogSlotId: slotId,
    templateKey: templateKey || resolvedSlot?.prebuiltKey || canonical,
    templateKind: isPrebuilt || resolvedSlot?.pushKind === "prebuilt" ? "prebuilt" : "custom",
    readinessRequired:
      PREBUILT_REQUIRED_TEMPLATES.includes(canonical) ||
      PREBUILT_REQUIRED_TEMPLATES.includes(templateKey || ""),
    isPrebuilt: !!isPrebuilt || resolvedSlot?.pushKind === "prebuilt",
    autoTrigger: autoTrigger || resolvedSlot?.autoTrigger || null,
    variableMappings: variableMappings || null,
    body: body || bodyComp?.text || "Template content pending",
    headerType: headerComp?.format || "NONE",
    headerValue: headerComp?.text || "",
    footerText: footerComp?.text || null,
    buttons: btnComp?.buttons || [],
    submissionStatus,
    metaTemplateId: metaTemplateId || null,
    metaApiError: null,
    updatedAt: new Date(),
    isActive: submissionStatus === "approved",
  };

  if (submissionStatus === "approved") update.approvedAt = new Date();
  if (submissionStatus === "pending_meta_review") update.submittedAt = new Date();
  if (submissionStatus === "rejected") update.rejectedAt = new Date();

  const doc = await MetaTemplate.findOneAndUpdate(
    { clientId, name: canonical },
    { $set: update, $setOnInsert: { createdAt: new Date() } },
    { upsert: true, new: true }
  );

  await patchClientSyncedTemplate(clientId, {
    name: canonical,
    id: metaTemplateId,
    status: syncedStatusFromSubmission(submissionStatus),
    components,
    category: update.category,
    language: update.language,
  });

  emitToClient(clientId, "templateStatusUpdated", {
    templateId: String(doc._id),
    templateName: canonical,
    catalogSlotId: slotId,
    newStatus: submissionStatus,
  });

  return doc;
}

async function patchClientSyncedTemplate(clientId, { name, id, status, components, category, language }) {
  const client = await Client.findOne({ clientId }).select("syncedMetaTemplates").lean();
  if (!client) return null;

  const list = Array.isArray(client.syncedMetaTemplates) ? [...client.syncedMetaTemplates] : [];
  const idx = list.findIndex((t) => t.name === name);
  const entry = {
    ...(idx >= 0 ? list[idx] : {}),
    name,
    id: id || (idx >= 0 ? list[idx].id : null),
    status: status || "PENDING",
    category,
    language,
    components: components?.length ? components : idx >= 0 ? list[idx].components : [],
    updatedAt: new Date(),
  };
  if (status === "APPROVED") entry.approvedAt = new Date();

  if (idx >= 0) list[idx] = entry;
  else list.push(entry);

  await Client.updateOne({ clientId }, { $set: { syncedMetaTemplates: list, templatesSyncedAt: new Date() } });
  return entry;
}

/**
 * Reconcile full Meta sync list into MetaTemplate + catalog slot links.
 */
async function reconcileSyncedTemplatesWithCatalog(clientId, syncedTemplates = []) {
  if (!clientId || !Array.isArray(syncedTemplates)) return { updated: 0 };
  let updated = 0;
  for (const tpl of syncedTemplates) {
    if (!tpl?.name) continue;
    const submissionStatus = mapMetaGraphStatus(tpl.status);
    const slot = getSlotByMetaName(tpl.name);
    const canonical = resolveCanonicalTemplateName(tpl.name);
    const metaLastEditedAt = parseMetaLastEdited(tpl.last_updated_time);
    const metaCategory = normalizeMetaCategory(tpl.category);

    const existing = await MetaTemplate.findOne({ clientId, name: canonical })
      .select("approvedAt rejectedAt submittedAt category")
      .lean();

    const $set = {
      clientId,
      name: canonical,
      catalogSlotId: slot?.id || null,
      templateKey: slot?.prebuiltKey || slot?.canonicalMetaName || tpl.name,
      language: tpl.language || "en",
      submissionStatus,
      metaTemplateId: tpl.id || null,
      body:
        tpl.components?.find((c) => c.type === "BODY")?.text ||
        "Synced from Meta",
      isActive: submissionStatus === "approved",
    };

    if (metaCategory) {
      $set.category = metaCategory;
    } else if (!existing?.category) {
      $set.category = "MARKETING";
    }

    if (metaLastEditedAt) {
      $set.metaLastEditedAt = metaLastEditedAt;
    }

    if (submissionStatus === "approved" && !existing?.approvedAt) {
      $set.approvedAt = metaLastEditedAt || new Date();
    }
    if (submissionStatus === "rejected" && !existing?.rejectedAt) {
      $set.rejectedAt = metaLastEditedAt || new Date();
    }
    if (submissionStatus === "pending_meta_review" && !existing?.submittedAt) {
      $set.submittedAt = metaLastEditedAt || new Date();
    }

    await MetaTemplate.findOneAndUpdate(
      { clientId, name: canonical },
      {
        $set,
        $setOnInsert: { createdAt: new Date(), source: "manual" },
      },
      { upsert: true }
    );
    updated += 1;
  }
  return { updated };
}

async function getClientMetaCredentials(clientId) {
  const client = await Client.findOne({ clientId })
    .select("wabaId whatsapp whatsappToken whatsapp.accessToken")
    .lean();
  if (!client) return null;
  const wabaId = client.wabaId || client.whatsapp?.wabaId;
  const raw = client.whatsappToken || client.whatsapp?.accessToken;
  if (!wabaId || !raw) return null;
  return { wabaId, token: decrypt(raw) || raw };
}

/**
 * Poll pending MetaTemplate rows; sync approved/rejected to MetaTemplate + Client cache.
 */
async function pollPendingMetaTemplatesForClient(clientId) {
  const creds = await getClientMetaCredentials(clientId);
  if (!creds) return { polled: 0, approved: 0, rejected: 0 };

  const pending = await MetaTemplate.find({
    clientId,
    submissionStatus: { $in: ["pending_meta_review", "submitting", "queued"] },
  }).lean();

  let approved = 0;
  let rejected = 0;
  let polled = 0;

  for (const template of pending) {
    polled += 1;
    try {
      let metaStatus = null;
      let metaId = template.metaTemplateId;
      let components = [];
      let rejectionReason = null;

      if (metaId) {
        const response = await axios.get(
          `https://graph.facebook.com/v21.0/${metaId}?fields=name,status,rejected_reason,components,category,language`,
          { headers: { Authorization: `Bearer ${creds.token}` }, timeout: 10000 }
        );
        metaStatus = response.data?.status;
        components = response.data?.components || [];
        rejectionReason = response.data?.rejected_reason;
        metaId = response.data?.id || metaId;
      } else {
        const url = `https://graph.facebook.com/v21.0/${creds.wabaId}/message_templates?name=${encodeURIComponent(template.name)}&fields=name,status,id,components,category,language`;
        const response = await axios.get(url, {
          headers: { Authorization: `Bearer ${creds.token}` },
          timeout: 12000,
        });
        const hit = (response.data?.data || [])[0];
        if (!hit) continue;
        metaStatus = hit.status;
        metaId = hit.id;
        components = hit.components || [];
      }

      const submissionStatus = mapMetaGraphStatus(metaStatus);
      if (submissionStatus === template.submissionStatus) {
        await MetaTemplate.findByIdAndUpdate(template._id, {
          $set: { lastPolledAt: new Date(), metaTemplateId: metaId },
        });
        continue;
      }

      const updateFields = {
        submissionStatus,
        metaTemplateId: metaId,
        lastPolledAt: new Date(),
        isActive: submissionStatus === "approved",
      };
      if (submissionStatus === "approved") {
        updateFields.approvedAt = new Date();
        approved += 1;
      }
      if (submissionStatus === "rejected") {
        updateFields.rejectedAt = new Date();
        updateFields.rejectionReason = rejectionReason || "Rejected by Meta";
        rejected += 1;
      }

      await MetaTemplate.findByIdAndUpdate(template._id, { $set: updateFields });

      await patchClientSyncedTemplate(clientId, {
        name: template.name,
        id: metaId,
        status: syncedStatusFromSubmission(submissionStatus),
        components,
      });

      emitToClient(clientId, "templateStatusUpdated", {
        templateId: String(template._id),
        templateName: template.name,
        catalogSlotId: template.catalogSlotId,
        newStatus: submissionStatus,
        rejectionReason: updateFields.rejectionReason || null,
      });
    } catch (err) {
      log.warn(`poll ${template.name} for ${clientId}: ${err.message}`);
    }
  }

  return { polled, approved, rejected };
}

/**
 * Align MetaTemplate rows with Client.syncedMetaTemplates after a patch or webhook.
 */
async function reconcileSync(clientId) {
  const client = await Client.findOne({ clientId }).select("syncedMetaTemplates").lean();
  if (!client) return { updated: 0 };
  return reconcileSyncedTemplatesWithCatalog(clientId, client.syncedMetaTemplates || []);
}

/**
 * Meta webhook: message_template_status_update → MetaTemplate + Client cache + socket.
 */
async function handleMessageTemplateStatusWebhook(clientId, value = {}) {
  const templateName = resolveCanonicalTemplateName(
    value.message_template_name || value.name
  );
  if (!templateName || !clientId) return null;

  const submissionStatus = mapMetaGraphStatus(value.event);
  const slot = getSlotByMetaName(templateName);

  const update = {
    submissionStatus,
    metaTemplateId: value.message_template_id ? String(value.message_template_id) : null,
    metaApiError: null,
    isActive: submissionStatus === "approved",
    updatedAt: new Date(),
    catalogSlotId: slot?.id || null,
  };
  if (submissionStatus === "approved") update.approvedAt = new Date();
  if (submissionStatus === "rejected") {
    update.rejectedAt = new Date();
    update.rejectionReason =
      value.rejection_info?.reason || value.reason || "Rejected by Meta";
  }
  if (submissionStatus === "pending_meta_review") update.submittedAt = new Date();

  const doc = await MetaTemplate.findOneAndUpdate(
    { clientId, name: templateName },
    {
      $set: update,
      $setOnInsert: { createdAt: new Date(), clientId, name: templateName, source: "manual" },
    },
    { upsert: true, new: true }
  );

  await patchClientSyncedTemplate(clientId, {
    name: templateName,
    id: update.metaTemplateId,
    status: syncedStatusFromSubmission(submissionStatus),
    category: value.message_template_category || doc?.category,
    language: value.message_template_language || doc?.language || "en",
  });

  await reconcileSync(clientId);

  emitToClient(clientId, "templateStatusUpdated", {
    templateId: String(doc._id),
    templateName,
    catalogSlotId: doc.catalogSlotId || slot?.id || null,
    status: syncedStatusFromSubmission(submissionStatus),
    newStatus: submissionStatus,
    rejectionReason: update.rejectionReason || null,
  });

  log.info(`[TemplateLifecycle] Webhook ${value.event} for ${templateName} (${clientId})`);
  return doc;
}

module.exports = {
  recordTemplateSubmission,
  patchClientSyncedTemplate,
  reconcileSyncedTemplatesWithCatalog,
  reconcileSync,
  handleMessageTemplateStatusWebhook,
  pollPendingMetaTemplatesForClient,
  mapMetaGraphStatus,
  syncedStatusFromSubmission,
};
