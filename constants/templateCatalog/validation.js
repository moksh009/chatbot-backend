"use strict";

const Client = require("../../models/Client");
const TemplateCatalogAudit = require("../../models/TemplateCatalogAudit");
const { resolveSlotsForClient } = require("./resolveSlots");
const { getCatalogVersion } = require("./catalog");
const { MULTI_STORE_MODEL } = require("../../services/templateBrandOverrides");

/**
 * Compare catalog slots vs tenant synced Meta library.
 */
async function auditClientCatalog(client, opts = {}) {
  const synced =
    opts.syncedTemplates ||
    (Array.isArray(client?.syncedMetaTemplates) ? client.syncedMetaTemplates : []);

  const resolved = await resolveSlotsForClient(client.clientId, {
    syncedTemplates: synced,
    loadMetaDocs: false,
  });

  const gaps = resolved.flatRows
    .filter((r) => r.isMissing || !r.isApproved)
    .map((r) => ({
      slotId: r.slot.id,
      title: r.slot.title,
      status: r.status,
      activeMetaName: r.activeMetaName,
      isMissing: r.isMissing,
      isApproved: r.isApproved,
    }));

  const approvedCount = resolved.flatRows.filter((r) => r.isApproved).length;
  const missingCount = resolved.flatRows.filter((r) => r.isMissing).length;
  const pendingCount = resolved.flatRows.filter(
    (r) => !r.isMissing && !r.isApproved
  ).length;

  const wabaId = client.wabaId || client.whatsapp?.wabaId;
  const rawToken = client.whatsappToken || client.whatsapp?.accessToken;

  return {
    clientId: client.clientId,
    businessName: client.businessName || client.brand?.businessName || client.clientId,
    catalogVersion: getCatalogVersion(),
    totalSlots: resolved.flatRows.length,
    approvedCount,
    missingCount,
    pendingCount,
    needsAction: gaps.length > 0,
    gaps,
    wabaConnected: !!(wabaId && rawToken),
    multiStoreModel: MULTI_STORE_MODEL.id,
  };
}

async function persistCatalogAudit(audit) {
  return TemplateCatalogAudit.create({
    ...audit,
    auditedAt: new Date(),
  });
}

/**
 * Run drift validation for all active WhatsApp clients; store latest audit per client.
 */
async function runCatalogValidationJob({ limit = 200 } = {}) {
  const clients = await Client.find({
    isActive: { $ne: false },
    $or: [
      { wabaId: { $exists: true, $ne: "" } },
      { "whatsapp.wabaId": { $exists: true, $ne: "" } },
    ],
  })
    .select("clientId businessName brand syncedMetaTemplates wabaId whatsapp wabaId whatsappToken")
    .limit(limit)
    .lean();

  const results = [];
  let needsActionTotal = 0;

  for (const client of clients) {
    try {
      const audit = await auditClientCatalog(client);
      await persistCatalogAudit(audit);
      if (audit.needsAction) needsActionTotal++;
      results.push({
        clientId: audit.clientId,
        needsAction: audit.needsAction,
        missingCount: audit.missingCount,
        approvedCount: audit.approvedCount,
      });
    } catch (err) {
      results.push({
        clientId: client.clientId,
        error: err.message,
      });
    }
  }

  return {
    scanned: clients.length,
    needsActionTotal,
    results,
    multiStoreModel: MULTI_STORE_MODEL,
  };
}

async function getLatestAudits({ limit = 50, needsActionOnly = false } = {}) {
  const match = needsActionOnly ? { needsAction: true } : {};
  const rows = await TemplateCatalogAudit.find(match)
    .sort({ auditedAt: -1 })
    .limit(limit)
    .lean();

  const byClient = new Map();
  for (const row of rows) {
    if (!byClient.has(row.clientId)) byClient.set(row.clientId, row);
  }
  return Array.from(byClient.values());
}

module.exports = {
  auditClientCatalog,
  persistCatalogAudit,
  runCatalogValidationJob,
  getLatestAudits,
};
