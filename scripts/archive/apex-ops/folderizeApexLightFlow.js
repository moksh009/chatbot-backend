#!/usr/bin/env node
/**
 * Split Apex Light flow into in-canvas folders (parentId groups) for Flow Builder.
 * Does NOT change runtime edges — same bot behaviour after publish.
 *
 * Usage:
 *   node scripts/folderizeApexLightFlow.js
 *   node scripts/folderizeApexLightFlow.js --clientId=shubhampatelsbusiness_1cfb2b
 *   node scripts/folderizeApexLightFlow.js --dry-run
 *   node scripts/folderizeApexLightFlow.js --from-db          # folderize Mongo copy (not repo seed)
 *   node scripts/folderizeApexLightFlow.js --keep-positions   # don't re-grid nodes inside folders
 *
 * Requires MONGODB_URI. After run: hard-refresh Flow Builder (avoid stale tab Publish overwriting).
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Client = require("../models/Client");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { clearTriggerCache } = require("../utils/triggerEngine");
const { clearClientCache } = require("../middleware/apiCache");
const { folderizeApexFlowGraph } = require("../utils/apexFlowFolderize");
const { buildFlow, FLOW_ID, FLOW_NAME } = require("../data/apexLightOwnerFlow");

const DEFAULT_CLIENT_ID = "shubhampatelsbusiness_1cfb2b";

function parseArgs() {
  const dryRun = process.argv.includes("--dry-run");
  const fromDb = process.argv.includes("--from-db");
  const keepPositions = process.argv.includes("--keep-positions");
  const clientArg = process.argv.find((a) => a.startsWith("--clientId="));
  const clientId =
    (clientArg && clientArg.split("=").slice(1).join("=").trim()) ||
    process.env.APEX_SYNC_CLIENT_ID ||
    process.env.SYNC_CLIENT_ID ||
    DEFAULT_CLIENT_ID;
  return { dryRun, fromDb, keepPositions, clientId };
}

async function loadGraph(fromDb, clientId) {
  if (!fromDb) {
    const built = buildFlow();
    return { nodes: built.nodes, edges: built.edges, source: "repo:buildFlow()" };
  }
  const flowDoc = await WhatsAppFlow.findOne({ clientId, flowId: FLOW_ID })
    .select("nodes edges publishedNodes publishedEdges")
    .lean();
  if (!flowDoc?.nodes?.length) {
    const client = await Client.findOne({ clientId }).select("visualFlows").lean();
    const vf = (client?.visualFlows || []).find((f) => f.id === FLOW_ID);
    if (!vf?.nodes?.length) {
      throw new Error(`No Apex flow in DB for ${clientId} / ${FLOW_ID}. Run setupApexOwnerSupportFlow.js first.`);
    }
    return {
      nodes: vf.nodes,
      edges: vf.edges || [],
      source: "client.visualFlows",
    };
  }
  const nodes = flowDoc.publishedNodes?.length ? flowDoc.publishedNodes : flowDoc.nodes;
  const edges = flowDoc.publishedEdges?.length ? flowDoc.publishedEdges : flowDoc.edges;
  return { nodes, edges, source: "WhatsAppFlow" };
}

async function persist(clientId, nodes, edges) {
  const now = new Date();
  await WhatsAppFlow.updateOne(
    { clientId, flowId: FLOW_ID },
    {
      $set: {
        nodes,
        edges,
        publishedNodes: nodes,
        publishedEdges: edges,
        updatedAt: now,
        lastSyncedAt: now,
      },
    }
  );

  const client = await Client.findOne({ clientId }).select("visualFlows").lean();
  const vf = (client?.visualFlows || []).map((f) =>
    f.id === FLOW_ID ? { ...f, nodes, edges, updatedAt: now } : f
  );
  if (!vf.some((f) => f.id === FLOW_ID)) {
    vf.push({
      id: FLOW_ID,
      name: FLOW_NAME,
      platform: "whatsapp",
      folderId: "",
      isActive: true,
      nodes,
      edges,
      updatedAt: now,
    });
  }
  await Client.updateOne({ clientId }, { $set: { visualFlows: vf } });
  clearTriggerCache(clientId);
  await clearClientCache(clientId);
}

async function run() {
  const { dryRun, fromDb, keepPositions, clientId } = parseArgs();
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI or MONGO_URI is required");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 90000 });

  const client = await Client.findOne({ clientId }).select("clientId").lean();
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const { nodes: rawNodes, edges: rawEdges, source } = await loadGraph(fromDb, clientId);
  const { nodes, edges, stats } = folderizeApexFlowGraph(rawNodes, rawEdges, {
    keepPositions,
    addEntryEdges: true,
  });

  const report = {
    success: true,
    dryRun,
    clientId,
    flowId: FLOW_ID,
    source,
    before: { nodes: rawNodes.length, edges: rawEdges.length },
    after: { nodes: nodes.length, edges: edges.length },
    stats,
    note: dryRun
      ? "No DB writes (dry-run)."
      : "Mongo + visualFlows updated. Hard-refresh Flow Builder before Publish.",
  };

  console.log(JSON.stringify(report, null, 2));

  if (!dryRun) {
    await persist(clientId, nodes, edges);
    console.warn("\n[folderizeApexLightFlow] Done. Open Flow Builder → root canvas shows folder cards; double-click to edit each section.");
  }
}

run()
  .catch((err) => {
    console.error("[folderizeApexLightFlow] Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
