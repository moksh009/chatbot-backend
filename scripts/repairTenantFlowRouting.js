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
 *   node scripts/repairTenantFlowRouting.js delitech_smarthomes --dry-run
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Client = require("../models/Client");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { clearTriggerCache } = require("../utils/triggerEngine");
const { invalidateFlowGraphCache } = require("../utils/flowGraphCache");
const { invalidateClientCache } = require("../utils/clientCache");
const { loadClientFlowSources } = require("../utils/flowGraphResolver");

function resolveClientId() {
  const arg = process.argv.find((a) => a.startsWith("--clientId="));
  if (arg) return arg.split("=").slice(1).join("=").trim();
  const positional = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
  return positional || process.env.REPAIR_CLIENT_ID || "delitech_smarthomes";
}

function pickBestGraph(sources) {
  const published = sources.whatsappFlows.find(
    (f) => f.status === "PUBLISHED" && (f.publishedNodes?.length || f.nodes?.length)
  );
  if (published) {
    return {
      flowId: published.flowId,
      name: published.name,
      nodes: published.publishedNodes?.length ? published.publishedNodes : published.nodes,
      edges: published.publishedEdges?.length ? published.publishedEdges : published.edges,
      from: "whatsapp_published",
    };
  }

  const activeVf = sources.visualFlows.find((f) => f.isActive && f.nodes?.length);
  if (activeVf) {
    return {
      flowId: activeVf.id,
      name: activeVf.name,
      nodes: activeVf.nodes,
      edges: activeVf.edges,
      from: "visual_active",
    };
  }

  const vf = sources.visualFlows.find((f) => f.nodes?.length);
  if (vf) {
    return {
      flowId: vf.id,
      name: vf.name,
      nodes: vf.nodes,
      edges: vf.edges,
      from: "visual_any",
    };
  }

  const draft = sources.whatsappFlows.find((f) => f.nodes?.length);
  if (draft) {
    return {
      flowId: draft.flowId,
      name: draft.name,
      nodes: draft.nodes,
      edges: draft.edges,
      from: "whatsapp_draft",
    };
  }

  if (sources.legacyNodes.length) {
    return {
      flowId: "legacy_main",
      name: "Main automation",
      nodes: sources.legacyNodes,
      edges: sources.legacyEdges,
      from: "legacy_flowNodes",
    };
  }

  return null;
}

async function run() {
  const clientId = resolveClientId();
  const dryRun = process.argv.includes("--dry-run");
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI required");

  await mongoose.connect(uri);
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const sources = await loadClientFlowSources(clientId);
  const best = pickBestGraph(sources);
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
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
