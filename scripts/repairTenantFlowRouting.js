#!/usr/bin/env node
"use strict";

/**
 * Repair Delitech / Apex (or any tenant) flow routing:
 * - Ensures WhatsAppFlow doc exists and is PUBLISHED with publishedNodes
 * - Syncs Client.visualFlows + legacy flowNodes/flowEdges
 * - Clears trigger + flow graph caches
 *
 * Usage:
 *   MONGODB_URI=... node scripts/repairTenantFlowRouting.js delitech_smarthomes
 *   MONGODB_URI=... node scripts/repairTenantFlowRouting.js --clientId=shubhampatelsbusiness_1cfb2b
 *   node scripts/repairTenantFlowRouting.js delitech_smarthomes --flowId=flow_wizard_1781340681165_0_main_commerce
 *   node scripts/repairTenantFlowRouting.js delitech_smarthomes --dry-run
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Client = require("../models/Client");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { clearTriggerCache } = require('../utils/flow/triggerEngine');
const { invalidateFlowGraphCache } = require('../utils/flow/flowGraphCache');
const { invalidateClientCache } = require('../utils/core/clientCache');
const { loadClientFlowSources } = require('../utils/flow/flowGraphResolver');

function resolveClientId() {
  const arg = process.argv.find((a) => a.startsWith("--clientId="));
  if (arg) return arg.split("=").slice(1).join("=").trim();
  const positional = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
  return positional || process.env.REPAIR_CLIENT_ID || "delitech_smarthomes";
}

function resolveFlowId() {
  const arg = process.argv.find((a) => a.startsWith("--flowId="));
  if (arg) return arg.split("=").slice(1).join("=").trim();
  return process.env.REPAIR_FLOW_ID || "";
}

function graphFromWaDoc(doc) {
  if (!doc) return null;
  const nodes = doc.publishedNodes?.length
    ? doc.publishedNodes
    : doc.nodes?.length
      ? doc.nodes
      : null;
  if (!nodes?.length) return null;
  return {
    flowId: doc.flowId,
    name: doc.name,
    nodes,
    edges: doc.publishedEdges?.length ? doc.publishedEdges : doc.edges || [],
  };
}

function graphFromVf(vf) {
  if (!vf) return null;
  if (vf.nodes?.length) {
    return {
      flowId: vf.id,
      name: vf.name,
      nodes: vf.nodes,
      edges: vf.edges || [],
    };
  }
  const metaN = Number(vf.nodeCount) || 0;
  if (metaN > 0) return null;
  return null;
}

function graphFromWaFlowId(sources, flowId) {
  if (!flowId) return null;
  const doc = sources.whatsappFlows.find((f) => String(f.flowId) === String(flowId));
  const g = graphFromWaDoc(doc);
  return g ? { ...g, from: "whatsapp_flowId" } : null;
}

function pickBestGraph(sources, { flowIdHint = "" } = {}) {
  const hinted = graphFromWaFlowId(sources, flowIdHint);
  if (hinted) return hinted;

  const published = sources.whatsappFlows.find((f) => f.status === "PUBLISHED");
  const fromPub = graphFromWaDoc(published);
  if (fromPub) return { ...fromPub, from: "whatsapp_published" };

  const activeVf = sources.visualFlows.find((f) => f.isActive);
  const fromActiveVf = graphFromVf(activeVf);
  if (fromActiveVf) return { ...fromActiveVf, from: "visual_active" };

  const fromActiveVfWa = graphFromWaFlowId(sources, activeVf?.id);
  if (fromActiveVfWa) return { ...fromActiveVfWa, from: "visual_active_wa" };

  const waCandidates = sources.whatsappFlows
    .map((doc) => ({ doc, g: graphFromWaDoc(doc) }))
    .filter((x) => x.g?.nodes?.length)
    .sort((a, b) => (b.g.nodes.length || 0) - (a.g.nodes.length || 0));
  if (waCandidates[0]) {
    return { ...waCandidates[0].g, from: "whatsapp_largest" };
  }

  for (const doc of sources.whatsappFlows) {
    const g = graphFromWaDoc(doc);
    if (g) return { ...g, from: "whatsapp_any" };
  }

  for (const vf of sources.visualFlows) {
    const g = graphFromVf(vf);
    if (g) return { ...g, from: "visual_any" };
  }

  if (sources.legacyNodes.length) {
    const activeId =
      activeVf?.id ||
      published?.flowId ||
      sources.whatsappFlows[0]?.flowId ||
      `flow_${sources.legacyNodes.length}_main`;
    return {
      flowId: activeId === "legacy_main" ? `flow_main_${Date.now()}` : activeId,
      name: activeVf?.name || published?.name || "Main automation",
      nodes: sources.legacyNodes,
      edges: sources.legacyEdges,
      from: "legacy_flowNodes",
    };
  }

  return null;
}

async function run() {
  const clientId = resolveClientId();
  const flowIdHint = resolveFlowId();
  const dryRun = process.argv.includes("--dry-run");
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI required");

  await mongoose.connect(uri);
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const sources = await loadClientFlowSources(clientId);
  const best = pickBestGraph(sources, { flowIdHint });
  if (!best?.nodes?.length) {
    console.error(`[repair] No flow graph found for ${clientId}. Run setup script or import flows first.`);
    process.exit(1);
  }

  console.log(`[repair] ${clientId} — using graph from ${best.from} (${best.nodes.length} nodes, ${(best.edges || []).length} edges)`);

  if (dryRun) {
    console.log("[repair] Dry run — no writes.");
    process.exit(0);
  }

  const now = new Date();
  const flowId = best.flowId === "legacy_main" ? `flow_${clientId}_main` : best.flowId;

  await WhatsAppFlow.updateMany(
    { clientId, platform: "whatsapp", flowId: { $ne: flowId } },
    { $set: { status: "DRAFT" } }
  );

  await WhatsAppFlow.findOneAndUpdate(
    { clientId, flowId },
    {
      $set: {
        clientId,
        flowId,
        name: best.name || `${client.businessName || clientId} — WhatsApp`,
        platform: "whatsapp",
        status: "PUBLISHED",
        version: 1,
        nodes: best.nodes,
        edges: best.edges || [],
        publishedNodes: best.nodes,
        publishedEdges: best.edges || [],
        updatedAt: now,
        lastSyncedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true, new: true }
  );

  const visualEntry = {
    id: flowId,
    name: best.name || "Main WhatsApp flow",
    platform: "whatsapp",
    folderId: "",
    isActive: true,
    nodes: best.nodes,
    edges: best.edges || [],
    updatedAt: now,
  };

  await Client.updateOne(
    { clientId },
    {
      $set: {
        flowNodes: best.nodes,
        flowEdges: best.edges || [],
        wizardCompleted: true,
      },
      $pull: { visualFlows: { id: flowId } },
    }
  );
  await Client.updateOne({ clientId }, { $push: { visualFlows: visualEntry } });

  clearTriggerCache(clientId);
  invalidateFlowGraphCache(clientId);
  invalidateClientCache(clientId);

  console.log(`[repair] Done. Published flowId=${flowId}. Restart API and send "hi" on WhatsApp to verify.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
