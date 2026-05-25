#!/usr/bin/env node
"use strict";

/**
 * Sync Flow Builder UI with live WhatsApp graphs (fixes 0 Steps / 0 Links).
 * Writes resolved graphs into WhatsAppFlow + Client.visualFlows + flowNodes.
 *
 * Usage:
 *   node scripts/syncFlowBuilderGraphs.js shubhampatelsbusiness_1cfb2b
 *   node scripts/syncFlowBuilderGraphs.js --clientId=delitech_smarthomes --dry-run
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Client = require("../models/Client");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { clearTriggerCache } = require('../utils/flow/triggerEngine');
const { invalidateFlowGraphCache } = require('../utils/flow/flowGraphCache');
const { invalidateClientCache } = require('../utils/core/clientCache');
const {
  loadClientFlowSources,
  resolveFlowGraphByRef,
  flattenFlowNodes,
} = require('../utils/flow/flowGraphResolver');
const { applyCanvasLayout } = require('../utils/flow/flowLayoutOrganize');

function resolveClientId() {
  const arg = process.argv.find((a) => a.startsWith("--clientId="));
  if (arg) return arg.split("=").slice(1).join("=").trim();
  const positional = process.argv.find(
    (a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]
  );
  return positional || process.env.SYNC_CLIENT_ID || "shubhampatelsbusiness_1cfb2b";
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
  const flowIds = new Set();
  for (const d of sources.whatsappFlows) {
    if (d.flowId) flowIds.add(String(d.flowId));
  }
  for (const vf of sources.visualFlows) {
    if (vf.id) flowIds.add(String(vf.id));
  }

  if (!flowIds.size && sources.legacyNodes.length) {
    flowIds.add("legacy_main");
  }

  console.log(`[syncFlowBuilder] ${clientId} — ${flowIds.size} flow id(s) to resolve`);

  const now = new Date();
  let synced = 0;

  for (const flowId of flowIds) {
    const resolved = await resolveFlowGraphByRef(clientId, flowId, { sources });
    if (!resolved?.nodes?.length) {
      console.log(`  skip ${flowId} — no graph`);
      continue;
    }

    const layout = applyCanvasLayout(resolved.nodes, resolved.edges || [], {
      keepPositions: true,
      addEntryEdges: true,
      stampSections: true,
    });
    const syncNodes = layout.nodes;
    const syncEdges = layout.edges;
    const flat = flattenFlowNodes(syncNodes);
    console.log(
      `  ${flowId}: ${flat.length} steps, ${syncEdges.length} links (${resolved.isLegacy ? "legacy" : "resolved"})${
        layout.layoutApplied ? " [layout]" : ""
      }`
    );

    if (dryRun) continue;

    const isPublished = resolved.status === "PUBLISHED";
    await WhatsAppFlow.findOneAndUpdate(
      { clientId, flowId: resolved.id || flowId },
      {
        $set: {
          clientId,
          flowId: resolved.id || flowId,
          name: resolved.name || "WhatsApp flow",
          platform: "whatsapp",
          status: isPublished ? "PUBLISHED" : "DRAFT",
          nodes: syncNodes,
          edges: syncEdges,
          layoutSpecVersion: layout.layoutSpecVersion || "",
          ...(isPublished
            ? {
                publishedNodes: syncNodes,
                publishedEdges: syncEdges,
              }
            : {}),
          updatedAt: now,
          lastSyncedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    const vfIdx = (client.visualFlows || []).findIndex(
      (v) => String(v.id) === String(flowId) || String(v.id) === String(resolved.id)
    );
    const entry = {
      id: resolved.id || flowId,
      name: resolved.name || "WhatsApp flow",
      platform: "whatsapp",
      folderId: vfIdx >= 0 ? client.visualFlows[vfIdx].folderId || "" : "",
      isActive: isPublished,
      nodes: syncNodes,
      edges: syncEdges,
      nodeCount: flat.length,
      edgeCount: syncEdges.length,
      layoutSpecVersion: layout.layoutSpecVersion || "",
      updatedAt: now,
    };

    if (vfIdx >= 0) {
      client.visualFlows[vfIdx] = { ...client.visualFlows[vfIdx], ...entry };
    } else {
      client.visualFlows = client.visualFlows || [];
      client.visualFlows.push(entry);
    }

    if (isPublished) {
      client.flowNodes = syncNodes;
      client.flowEdges = syncEdges;
    }

    synced += 1;
  }

  if (!dryRun && synced > 0) {
    client.markModified("visualFlows");
    await client.save();
    clearTriggerCache(clientId);
    invalidateFlowGraphCache(clientId);
    invalidateClientCache(clientId);
    console.log(`[syncFlowBuilder] Done — synced ${synced} flow(s). Restart API and refresh Flow Builder.`);
  } else if (dryRun) {
    console.log("[syncFlowBuilder] Dry run — no writes.");
  } else {
    console.log("[syncFlowBuilder] Nothing to sync. Try: node scripts/setupApexOwnerSupportFlow.js");
  }

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
