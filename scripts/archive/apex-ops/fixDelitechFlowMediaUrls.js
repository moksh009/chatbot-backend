#!/usr/bin/env node
"use strict";

/**
 * One-time: fix localhost logo URLs in published Delitech (or any) flow and re-cache.
 * Usage: MONGODB_URI=... node scripts/fixDelitechFlowMediaUrls.js [clientId]
 */

require("dotenv").config();
const connectDB = require("../db");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const Client = require("../models/Client");
const { sanitizeFlowNodesMedia } = require('../../../utils/flow/sanitizeFlowMedia');
const { setCachedFlowGraph, invalidateFlowGraphCache } = require('../../../utils/flow/flowGraphCache');
const { clearTriggerCache } = require('../../../utils/flow/triggerEngine');

async function main() {
  const clientId = process.argv[2] || "delitech_smarthomes";
  await connectDB();

  const flows = await WhatsAppFlow.find({ clientId, status: "PUBLISHED" }).lean();
  if (!flows.length) {
    console.log(`No published flows for ${clientId}`);
    process.exit(0);
  }

  for (const flow of flows) {
    const nodes = sanitizeFlowNodesMedia(flow.publishedNodes || flow.nodes || []);
    const edges = flow.publishedEdges || flow.edges || [];
    await WhatsAppFlow.updateOne(
      { _id: flow._id },
      { $set: { publishedNodes: nodes, nodes } }
    );
    invalidateFlowGraphCache(clientId, flow.flowId || String(flow._id));
    setCachedFlowGraph(clientId, flow.flowId || String(flow._id), {
      nodes,
      edges,
      flowId: flow.flowId,
      mongoId: String(flow._id),
      name: flow.name,
    });
    console.log(`Fixed flow ${flow.name || flow.flowId} (${nodes.length} nodes)`);
  }

  const logo = flows[0]?.publishedNodes?.find((n) => n.id?.includes("main_menu"))?.data?.imageUrl;
  const client = await Client.findOne({ clientId }).select("businessLogo brand").lean();
  const { sanitizeInteractiveImageUrl } = require('../../../utils/flow/sanitizeFlowMedia');
  const safeLogo = sanitizeInteractiveImageUrl(
    client?.businessLogo || client?.brand?.logoUrl || ""
  );
  if (safeLogo) {
    await Client.updateOne(
      { clientId },
      {
        $set: {
          businessLogo: safeLogo,
          "brand.logoUrl": safeLogo,
          "brand.businessLogo": safeLogo,
        },
      }
    );
    console.log(`Client logo -> ${safeLogo}`);
  }

  clearTriggerCache(clientId);
  console.log("Done. Republish from Flow Builder optional; cache cleared.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
