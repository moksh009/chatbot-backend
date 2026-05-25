"use strict";

const axios = require("axios");
const Client = require("../models/Client");
const User = require("../models/User");
const { STANDARD_TEMPLATES } = require("../constants/standardTemplates");
const { decrypt } = require("../utils/core/encryption");
const log = require("../utils/core/logger")("TemplateAdminOps");
const { recordTemplateSubmission } = require("./templateLifecycleBridge");
const {
  applyOverridesToStandardTemplate,
} = require("./templateBrandOverrides");
const { getUnifiedTemplateReadiness } = require("../constants/templateCatalog/readiness");
const { auditClientCatalog } = require("../constants/templateCatalog/validation");

async function assertSuperAdmin(userId) {
  const user = await User.findById(userId).select("role").lean();
  if (!user || user.role !== "SUPER_ADMIN") {
    const err = new Error("SUPER_ADMIN only");
    err.status = 403;
    throw err;
  }
}

function getClientWaCreds(client) {
  const wabaId = client.wabaId || client.whatsapp?.wabaId;
  const rawToken = client.whatsappToken || client.whatsapp?.accessToken;
  if (!wabaId || !rawToken) return null;
  const token = decrypt(rawToken) || rawToken;
  return { wabaId, token };
}

async function pushStandardTemplateToMeta(client, standardTemplate, slotId) {
  const creds = getClientWaCreds(client);
  if (!creds) {
    return { ok: false, reason: "missing_waba_credentials", templateId: standardTemplate.id };
  }

  const { template: merged, applied, skipped } = applyOverridesToStandardTemplate(
    standardTemplate,
    slotId,
    client
  );
  if (skipped) {
    return { ok: false, reason: "slot_disabled", templateId: standardTemplate.id };
  }

  const payload = {
    name: merged.name,
    language: merged.language,
    category: merged.category,
    components: merged.components,
  };

  try {
    const url = `https://graph.facebook.com/v21.0/${creds.wabaId}/message_templates`;
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });
    const metaResult = response.data || {};
    await recordTemplateSubmission({
      clientId: client.clientId,
      metaName: merged.name,
      metaTemplateId: metaResult.id || null,
      metaStatus: metaResult.status || "PENDING",
      components: merged.components,
      category: merged.category,
      language: merged.language,
      source: "eco_push",
      catalogSlotId: slotId,
      body: merged.components?.find((c) => c.type === "BODY")?.text,
    }).catch(() => {});

    return {
      ok: true,
      templateId: standardTemplate.id,
      metaName: merged.name,
      overridesApplied: applied,
      meta: metaResult,
    };
  } catch (err) {
    const details = err.response?.data || err.message;
    return {
      ok: false,
      templateId: standardTemplate.id,
      reason: "meta_error",
      details,
    };
  }
}

/**
 * Bulk push eco starter pack to one or many clients (SUPER_ADMIN).
 */
async function bulkPushEcoPack({
  clientIds = [],
  skipExisting = true,
  staggerMs = 600,
} = {}) {
  const query =
    clientIds.length > 0
      ? { clientId: { $in: clientIds }, isActive: { $ne: false } }
      : {
          isActive: { $ne: false },
          $or: [
            { wabaId: { $exists: true, $ne: "" } },
            { "whatsapp.wabaId": { $exists: true, $ne: "" } },
          ],
        };

  const clients = await Client.find(query)
    .select("clientId businessName wabaId whatsapp whatsappToken syncedMetaTemplates templateBrandOverrides")
    .lean();

  const summary = {
    clients: clients.length,
    pushed: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (const client of clients) {
    const syncedNames = new Set(
      (client.syncedMetaTemplates || []).map((t) => String(t.name || ""))
    );
    const clientResult = { clientId: client.clientId, templates: [] };

    for (const tpl of STANDARD_TEMPLATES) {
      if (skipExisting && syncedNames.has(tpl.name)) {
        summary.skipped++;
        clientResult.templates.push({ id: tpl.id, status: "skipped_existing" });
        continue;
      }

      const hit = await pushStandardTemplateToMeta(client, tpl, tpl.id);
      clientResult.templates.push(hit);
      if (hit.ok) summary.pushed++;
      else if (hit.reason === "slot_disabled") summary.skipped++;
      else summary.failed++;

      if (staggerMs > 0) {
        await new Promise((r) => setTimeout(r, staggerMs));
      }
    }

    summary.results.push(clientResult);
  }

  log.info(
    `[BulkEcoPush] clients=${summary.clients} pushed=${summary.pushed} skipped=${summary.skipped} failed=${summary.failed}`
  );
  return summary;
}

/**
 * Approval board — readiness + latest audit per client.
 */
async function getApprovalBoard({ limit = 80, needsActionOnly = false } = {}) {
  const query = {
    isActive: { $ne: false },
    $or: [
      { wabaId: { $exists: true, $ne: "" } },
      { "whatsapp.wabaId": { $exists: true, $ne: "" } },
    ],
  };

  const clients = await Client.find(query)
    .select("clientId businessName brand syncedMetaTemplates wabaId")
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  const rows = [];
  for (const client of clients) {
    const synced = Array.isArray(client.syncedMetaTemplates)
      ? client.syncedMetaTemplates
      : [];
    const readiness = await getUnifiedTemplateReadiness(client.clientId, {
      syncedTemplates: synced,
    });
    const audit = await auditClientCatalog(client, { syncedTemplates: synced });

    if (needsActionOnly && !audit.needsAction) continue;

    rows.push({
      clientId: client.clientId,
      businessName: client.businessName || client.brand?.businessName || client.clientId,
      slotSummary: readiness.slotSummary,
      featureLevelCounts: readiness.featureLevelCounts,
      allFeaturesReady: readiness.allFeaturesReady,
      approvedSlots: audit.approvedCount,
      missingSlots: audit.missingCount,
      pendingSlots: audit.pendingCount,
      needsAction: audit.needsAction,
      gapCount: audit.gaps.length,
      topGaps: audit.gaps.slice(0, 4),
      wabaConnected: audit.wabaConnected,
    });
  }

  return {
    scanned: clients.length,
    returned: rows.length,
    needsActionCount: rows.filter((r) => r.needsAction).length,
    clients: rows,
  };
}

module.exports = {
  assertSuperAdmin,
  bulkPushEcoPack,
  getApprovalBoard,
  pushStandardTemplateToMeta,
};
