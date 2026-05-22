"use strict";

/**
 * Persist organized canvas graph for a tenant flow (WhatsAppFlow + visualFlows + cache).
 */
async function persistFlowCanvasGraph(clientId, flowId, nodes, edges, meta = {}) {
  const { resolveFlowListCounts } = require("./flowGraphResolver");
  const { setCachedFlowGraph } = require("./flowGraphCache");
  const { LAYOUT_SPEC_VERSION } = require("./flowLayoutSections");
  const listCounts = resolveFlowListCounts(nodes, null, edges, null, {});

  const WhatsAppFlow = require("../models/WhatsAppFlow");
  await WhatsAppFlow.updateOne(
    { clientId, flowId },
    {
      $set: {
        nodes,
        edges,
        layoutSpecVersion: meta.layoutSpecVersion || LAYOUT_SPEC_VERSION,
        updatedAt: new Date(),
      },
    },
    { upsert: false }
  ).catch(() => {});

  const Client = require("../models/Client");
  const client = await Client.findOne({ clientId }).select("visualFlows").lean();
  const vfIndex = (client?.visualFlows || []).findIndex((f) => String(f.id) === String(flowId));
  if (vfIndex !== -1) {
    await Client.updateOne(
      { clientId },
      {
        $set: {
          [`visualFlows.${vfIndex}.nodes`]: nodes,
          [`visualFlows.${vfIndex}.edges`]: edges,
          [`visualFlows.${vfIndex}.nodeCount`]: listCounts.nodeCount,
          [`visualFlows.${vfIndex}.edgeCount`]: listCounts.edgeCount,
          [`visualFlows.${vfIndex}.layoutSpecVersion`]: meta.layoutSpecVersion || LAYOUT_SPEC_VERSION,
          [`visualFlows.${vfIndex}.updatedAt`]: new Date(),
        },
      }
    );
  }

  setCachedFlowGraph(clientId, flowId, {
    flowId,
    nodes,
    edges,
    nodeCount: listCounts.nodeCount,
    edgeCount: listCounts.edgeCount,
    name: meta.name,
    platform: meta.platform,
    status: meta.status,
    layoutSpecVersion: meta.layoutSpecVersion || LAYOUT_SPEC_VERSION,
  });

  return { nodeCount: listCounts.nodeCount, edgeCount: listCounts.edgeCount };
}

module.exports = { persistFlowCanvasGraph };
