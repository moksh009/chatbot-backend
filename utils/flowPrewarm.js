"use strict";

const log = require("./logger")("FlowPrewarm");
const { setCachedFlowGraph } = require("./flowGraphCache");

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
 * Load published WhatsApp flows into Redis/L1 after Mongo connects (cold-start fix).
 */
async function prewarmFlowCacheForActiveClients() {
  if (process.env.FLOW_PREWARM === "false") {
    log.info("FLOW_PREWARM=false — skipping");
    return;
  }

  const Client = require("../models/Client");
  const WhatsAppFlow = require("../models/WhatsAppFlow");

  const clients = await Client.find(
    { isActive: { $ne: false }, phoneNumberId: { $exists: true, $ne: "" } },
    { clientId: 1 }
  )
    .limit(200)
    .lean();

  log.info(`[Prewarm] Loading published flows for ${clients.length} clients...`);
  let warmed = 0;

  await Promise.allSettled(
    clients.map(async (c) => {
      const flows = await WhatsAppFlow.find(
        { clientId: c.clientId, status: "PUBLISHED", isAutomation: { $ne: true } },
        { flowId: 1, publishedNodes: 1, publishedEdges: 1, nodes: 1, edges: 1 }
      ).lean();

      for (const flow of flows) {
        const pubNodes =
          flow.publishedNodes?.length > 0 ? flow.publishedNodes : flow.nodes || [];
        const pubEdges =
          flow.publishedEdges?.length > 0 ? flow.publishedEdges : flow.edges || [];
        if (!pubNodes.length) continue;

        const graph = {
          nodes: flattenRuntimeNodes(pubNodes),
          edges: pubEdges,
          flowId: flow.flowId,
        };
        setCachedFlowGraph(c.clientId, flow.flowId, graph);
        warmed += 1;
      }
    })
  );

  log.info(`[Prewarm] Cached ${warmed} published flow graph(s)`);
}

module.exports = { prewarmFlowCacheForActiveClients, flattenRuntimeNodes };
