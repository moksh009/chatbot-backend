"use strict";

const WhatsAppFlow = require("../models/WhatsAppFlow");

/** Flow Builder sidebar folders for wizard-generated multi-flow packs */
const WIZARD_PACK_FOLDERS = [
  { id: "folder_wizard_main", name: "Main commerce bot", createdAt: new Date() },
  { id: "folder_wizard_automation", name: "Automations", createdAt: new Date() },
];

function folderIdForPackFlow(f) {
  if (f?.slug === "main_commerce") return "folder_wizard_main";
  if (f?.isAutomation) return "folder_wizard_automation";
  return "folder_wizard_main";
}

function ensureWizardFlowFolders(existing = []) {
  const list = Array.isArray(existing) ? [...existing] : [];
  const ids = new Set(list.map((f) => f.id));
  for (const folder of WIZARD_PACK_FOLDERS) {
    if (!ids.has(folder.id)) {
      list.push({ ...folder, createdAt: folder.createdAt || new Date() });
    }
  }
  return list;
}

/**
 * Creates one WhatsAppFlow document per pack slice and returns metadata for Client.visualFlows.
 * @param {string} clientId
 * @param {Array<{ name, slug, nodes, edges, isAutomation?, automationTrigger? }>} flows
 * @param {{
 *   generatedBy?: string,
 *   status?: string,
 *   idPrefix?: string,
 *   folderId?: string,
 *   visualInlineGraph?: boolean,
 *   visualMaxNodes?: number
 * }} opts
 */
async function createFlowsFromCommercePack(clientId, flows, opts = {}) {
  const generatedBy = opts.generatedBy || "wizard";
  const status = opts.status || "PUBLISHED";
  const idPrefix = opts.idPrefix || "flow_wizard";
  const defaultFolderId = opts.folderId || "";
  const includeGraph = opts.visualInlineGraph !== false;
  const maxNodes =
    opts.visualMaxNodes === undefined ? 20 : opts.visualMaxNodes < 0 ? Number.POSITIVE_INFINITY : opts.visualMaxNodes;
  const base = Date.now();
  const created = [];

  for (let i = 0; i < (flows || []).length; i++) {
    const f = flows[i];
    const slug = String(f.slug || `flow_${i}`).replace(/[^a-z0-9_]/gi, "_");
    const flowId = `${idPrefix}_${base}_${i}_${slug}`;
    const nodes = f.nodes || [];
    const edges = f.edges || [];
    const folderId = defaultFolderId || folderIdForPackFlow(f);

    const doc = await WhatsAppFlow.create({
      clientId,
      flowId,
      name: f.name || "Generated flow",
      platform: "whatsapp",
      folderId,
      status,
      version: 1,
      nodes,
      edges,
      publishedNodes: status === "PUBLISHED" ? nodes : [],
      publishedEdges: status === "PUBLISHED" ? edges : [],
      isAutomation: !!f.isAutomation,
      automationTrigger: f.automationTrigger || "",
      generatedBy,
    });

    const isMain = f.slug === "main_commerce";
    const slim = includeGraph && nodes.length <= maxNodes;
    created.push({
      flowId,
      doc,
      f,
      isMain,
      visualEntry: {
        id: flowId,
        name: f.name || "Generated flow",
        platform: "whatsapp",
        isActive: isMain,
        folderId,
        nodes: slim ? nodes : [],
        edges: slim ? edges : [],
        nodeCount: nodes.length,
        edgeCount: edges.length,
        flowModelId: doc._id,
        createdAt: new Date(),
        updatedAt: new Date(),
        generatedBy,
      },
    });
  }

  const mainSlice = created.find((c) => c.isMain) || created[0];
  const mainNodes = mainSlice?.f?.nodes || [];
  const mainEdges = mainSlice?.f?.edges || [];
  const primaryFlowId = mainSlice?.flowId || null;
  const flowIds = created.map((c) => c.flowId);

  return {
    created,
    visualEntries: created.map((c) => c.visualEntry),
    primaryFlowId,
    flowIds,
    mainNodes,
    mainEdges,
  };
}

/**
 * Remove prior wizard / automation WhatsAppFlow rows (same filter as routes/wizard.js).
 */
async function deletePriorWizardFlows(clientId) {
  return WhatsAppFlow.deleteMany({
    clientId,
    $or: [
      { flowId: { $regex: "^flow_wizard_" } },
      { flowId: { $regex: "^flow_gfw_" } },
      { flowId: { $regex: "^auto_" } },
      { generatedBy: "wizard" },
      { generatedBy: "commerce_wizard_v2" },
      { isAutomation: true },
      { name: { $regex: "^Automation:" } },
    ],
  });
}

module.exports = {
  WIZARD_PACK_FOLDERS,
  folderIdForPackFlow,
  ensureWizardFlowFolders,
  createFlowsFromCommercePack,
  deletePriorWizardFlows,
};
