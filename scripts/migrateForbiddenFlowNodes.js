#!/usr/bin/env node
"use strict";

/**
 * Remove orphan V1-forbidden nodes and migrate wired legacy types for publish preflight.
 *
 * - order_action (CHECK_ORDER_STATUS) → shopify_call + success/not_found/error edges
 * - payment_link, cod_prepaid, review → removed when disconnected (no edges)
 *
 * Usage:
 *   node scripts/migrateForbiddenFlowNodes.js --clientId=delitech_smarthomes
 *   node scripts/migrateForbiddenFlowNodes.js --clientId=shubhampatelsbusiness_1cfb2b
 *   node scripts/migrateForbiddenFlowNodes.js --clientId=delitech_smarthomes --dry-run
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Client = require("../models/Client");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { isV1ForbiddenNodeType, normalizeNodeType } = require("../utils/flow/flowNodeContract");
const { preflightValidateFlowGraph } = require("../utils/flow/flowPublishPreflight");
const { clearTriggerCache } = require("../utils/flow/triggerEngine");
const { invalidateFlowGraphCache } = require("../utils/flow/flowGraphCache");
const { invalidateClientCache } = require("../utils/core/clientCache");

function resolveClientId() {
  const arg = process.argv.find((a) => a.startsWith("--clientId="));
  if (arg) return arg.split("=").slice(1).join("=").trim();
  const positional = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
  return positional || "";
}

function isConnected(nodeId, edges) {
  return edges.some((e) => e.source === nodeId || e.target === nodeId);
}

function migrateOrderActionNode(node) {
  const action = String(node.data?.actionType || node.data?.action || "CHECK_ORDER_STATUS").trim();
  return {
    ...node,
    type: "shopify_call",
    data: {
      ...node.data,
      label: node.data?.label || "Check Order Status",
      action,
      queryVariable: node.data?.queryVariable || "",
    },
  };
}

function migrateOrderActionEdges(nodeId, edges) {
  const related = edges.filter((e) => e.source === nodeId || e.target === nodeId);
  const rest = edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
  const out = related.filter((e) => e.source === nodeId);
  const inn = related.filter((e) => e.target === nodeId);

  const next = [...rest, ...inn];
  const defaultOut = out.filter((e) => !e.sourceHandle);
  const handledOut = out.filter((e) => e.sourceHandle);
  const footerTarget = defaultOut[0]?.target || handledOut[0]?.target;

  if (footerTarget) {
    const handles = ["success", "not_found", "error"];
    for (const handle of handles) {
      if (!next.some((e) => e.source === nodeId && e.sourceHandle === handle)) {
        next.push({
          id: `e_${nodeId}_${handle}`,
          source: nodeId,
          sourceHandle: handle,
          target: footerTarget,
        });
      }
    }
  }

  for (const e of handledOut) {
    if (!next.some((x) => x.id === e.id)) next.push(e);
  }

  return next;
}

function migrateGraph({ nodes = [], edges = [] } = {}) {
  const stats = {
    removedOrphans: [],
    migratedOrderAction: [],
    edgeUpdates: 0,
  };

  let nextNodes = [...nodes];
  let nextEdges = [...edges];

  const forbidden = nextNodes.filter((n) => isV1ForbiddenNodeType(n?.type));
  for (const node of forbidden) {
    const type = normalizeNodeType(node.type);
    if (type === "order_action" && isConnected(node.id, nextEdges)) {
      const idx = nextNodes.findIndex((n) => n.id === node.id);
      if (idx >= 0) {
        nextNodes[idx] = migrateOrderActionNode(node);
        const before = nextEdges.length;
        nextEdges = migrateOrderActionEdges(node.id, nextEdges);
        stats.migratedOrderAction.push(node.id);
        stats.edgeUpdates += Math.max(0, nextEdges.length - before);
      }
      continue;
    }
    if (!isConnected(node.id, nextEdges)) {
      nextNodes = nextNodes.filter((n) => n.id !== node.id);
      stats.removedOrphans.push(`${node.id}:${type}`);
    }
  }

  return { nodes: nextNodes, edges: nextEdges, stats };
}

async function run() {
  const clientId = resolveClientId();
  const dryRun = process.argv.includes("--dry-run");
  if (!clientId) throw new Error("--clientId required");

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI required");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 60000 });
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const pub = await WhatsAppFlow.findOne({ clientId, status: "PUBLISHED" });
  if (!pub?.publishedNodes?.length && !pub?.nodes?.length) {
    throw new Error(`No published flow for ${clientId}`);
  }

  const baseNodes = pub.publishedNodes?.length ? pub.publishedNodes : pub.nodes;
  const baseEdges = pub.publishedEdges?.length ? pub.publishedEdges : pub.edges || [];
  const { nodes, edges, stats } = migrateGraph({ nodes: baseNodes, edges: baseEdges });

  const pre = preflightValidateFlowGraph({ nodes, edges, client: client.toObject() });
  const blocks = (pre.errors || []).filter((e) => e.severity === "block");

  console.log(`[migrateForbidden] ${clientId}`);
  console.log(" stats:", JSON.stringify(stats));
  console.log(` preflight blocks: ${blocks.length}`);
  for (const b of blocks.slice(0, 8)) {
    console.log(`  - ${b.code} ${b.nodeId || ""} ${b.message?.slice(0, 90)}`);
  }

  if (dryRun) {
    console.log("[migrateForbidden] Dry run — no writes.");
    await mongoose.disconnect();
    process.exit(0);
  }

  if (blocks.length) {
    throw new Error(`Preflight still has ${blocks.length} block(s) after migration`);
  }

  const now = new Date();
  const flowId = pub.flowId;
  pub.nodes = nodes;
  pub.edges = edges;
  pub.publishedNodes = nodes;
  pub.publishedEdges = edges;
  pub.updatedAt = now;
  pub.lastSyncedAt = now;
  await pub.save();

  const vfIdx = (client.visualFlows || []).findIndex((v) => String(v.id) === String(flowId));
  if (vfIdx >= 0) {
    client.visualFlows[vfIdx].nodes = nodes;
    client.visualFlows[vfIdx].edges = edges;
    client.visualFlows[vfIdx].updatedAt = now;
    client.markModified("visualFlows");
  }
  client.flowNodes = nodes;
  client.flowEdges = edges;
  await client.save();

  clearTriggerCache(clientId);
  invalidateFlowGraphCache(clientId);
  invalidateClientCache(clientId);

  console.log(`[migrateForbidden] Done — flowId=${flowId}`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
