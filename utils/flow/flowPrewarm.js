"use strict";

const log = require('../core/logger')("FlowPrewarm");
const { setCachedFlowGraph } = require('./flowGraphCache');

const RUNTIME_SKIP = new Set(["folder", "group", "sticky", "comment"]);

function flattenRuntimeNodes(nodes) {
  const flat = [];
  function traverse(nodeList) {
    if (!Array.isArray(nodeList)) return;
    for (const node of nodeList) {
      if (node.type && !RUNTIME_SKIP.has(node.type)) flat.push(node);
      if (node.children) traverse(node.children);
      if (node.data?.nodes) traverse(node.data.nodes);
      if (node.nodes) traverse(node.nodes);
    }
  }
  traverse(nodes);
  return flat;
}

/**
 * Warm L1/Redis graph cache for one published flow document (publish path + boot prewarm).
 */
function warmPublishedFlowGraphCache(clientId, flow) {
  if (!clientId || !flow) return false;
  const pubNodes =
    flow.publishedNodes?.length > 0 ? flow.publishedNodes : flow.nodes || [];
  const pubEdges =
    flow.publishedEdges?.length > 0 ? flow.publishedEdges : flow.edges || [];
  if (!pubNodes.length) return false;

  setCachedFlowGraph(clientId, flow.flowId, {
    nodes: flattenRuntimeNodes(pubNodes),
    edges: pubEdges,
    flowId: flow.flowId,
    name: flow.name || "",
  });
  return true;
}

/**
 * Load primary published flow per tenant into Redis/L1 after Mongo connects (cold-start fix).
 * Phase A/B: one primary graph per client — not all PUBLISHED rows.
 */
async function prewarmFlowCacheForActiveClients() {
  if (process.env.FLOW_PREWARM === "false") {
    log.info("FLOW_PREWARM=false — skipping");
    return;
  }

  const Client = require("../../models/Client");
  const WhatsAppFlow = require("../../models/WhatsAppFlow");
  const { resolvePrimaryPublishedFlowId } = require("./flowGraphResolver");

  const clients = await Client.find(
    { isActive: { $ne: false }, phoneNumberId: { $exists: true, $ne: "" } },
    { clientId: 1, visualFlows: 1 }
  )
    .limit(200)
    .lean();

  log.info(`[Prewarm] Loading primary flow graphs for ${clients.length} clients...`);
  let warmed = 0;

  await Promise.allSettled(
    clients.map(async (c) => {
      const waFlows = await WhatsAppFlow.find(
        { clientId: c.clientId, isAutomation: { $ne: true } },
        {
          flowId: 1,
          status: 1,
          name: 1,
          publishedNodes: 1,
          publishedEdges: 1,
          nodes: 1,
          edges: 1,
          lastSyncedAt: 1,
          updatedAt: 1,
        }
      ).lean();

      const primaryId = resolvePrimaryPublishedFlowId({
        visualFlows: c.visualFlows,
        whatsappFlows: waFlows,
      });
      if (!primaryId) return;

      const flow = waFlows.find((f) => String(f.flowId) === String(primaryId));
      if (flow && warmPublishedFlowGraphCache(c.clientId, flow)) {
        warmed += 1;
      }
    })
  );

  log.info(`[Prewarm] Cached ${warmed} primary flow graph(s)`);
}

module.exports = {
  prewarmFlowCacheForActiveClients,
  warmPublishedFlowGraphCache,
  flattenRuntimeNodes,
};
