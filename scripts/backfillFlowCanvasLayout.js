#!/usr/bin/env node
"use strict";

/**
 * Backfill unified canvas layout for all tenants (multi-tenant SaaS).
 *
 * Usage:
 *   node scripts/backfillFlowCanvasLayout.js
 *   node scripts/backfillFlowCanvasLayout.js --clientId=acme_store
 *   node scripts/backfillFlowCanvasLayout.js --dry-run
 */

require("dotenv").config();
const mongoose = require("mongoose");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const clientArg = args.find((a) => a.startsWith("--clientId="));
const onlyClientId = clientArg ? clientArg.split("=")[1] : null;

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI required");
  await mongoose.connect(uri);

  const Client = require("../models/Client");
  const WhatsAppFlow = require("../models/WhatsAppFlow");
  const { applyCanvasLayout, countOrphanLayoutNodes } = require('../utils/flow/flowLayoutOrganize');
  const { persistFlowCanvasGraph } = require('../utils/flow/flowLayoutPersist');
  const { resolveFlowListCounts } = require('../utils/flow/flowGraphResolver');

  const clientQuery = onlyClientId ? { clientId: onlyClientId } : {};
  const clients = await Client.find(clientQuery).select("clientId visualFlows").lean();
  let updated = 0;

  for (const client of clients) {
    const flows = await WhatsAppFlow.find({ clientId: client.clientId })
      .select("flowId name nodes edges platform status")
      .lean();
    for (const doc of flows) {
      if (!doc.nodes?.length) continue;
      const orphans = countOrphanLayoutNodes(doc.nodes);
      if (orphans === 0) continue;
      const layout = applyCanvasLayout(doc.nodes, doc.edges || [], {
        keepPositions: true,
        addEntryEdges: true,
        stampSections: true,
        force: true,
      });
      console.log(
        `[layout] ${client.clientId} / ${doc.flowId}: orphans ${orphans} → ${layout.orphansAfter}`
      );
      if (dryRun) continue;
      await persistFlowCanvasGraph(client.clientId, doc.flowId, layout.nodes, layout.edges, {
        name: doc.name,
        platform: doc.platform,
        status: doc.status,
        layoutSpecVersion: layout.layoutSpecVersion,
      });
      updated += 1;
    }

    const vf = client.visualFlows || [];
    for (let i = 0; i < vf.length; i++) {
      const entry = vf[i];
      if (!entry?.nodes?.length) continue;
      const orphans = countOrphanLayoutNodes(entry.nodes);
      if (orphans === 0) continue;
      const layout = applyCanvasLayout(entry.nodes, entry.edges || [], {
        keepPositions: true,
        addEntryEdges: true,
        stampSections: true,
        force: true,
      });
      const counts = resolveFlowListCounts(layout.nodes, null, layout.edges, null, {});
      console.log(
        `[layout] ${client.clientId} visualFlows[${entry.id}]: orphans ${orphans} → ${layout.orphansAfter}`
      );
      if (dryRun) continue;
      await Client.updateOne(
        { clientId: client.clientId },
        {
          $set: {
            [`visualFlows.${i}.nodes`]: layout.nodes,
            [`visualFlows.${i}.edges`]: layout.edges,
            [`visualFlows.${i}.nodeCount`]: counts.nodeCount,
            [`visualFlows.${i}.edgeCount`]: counts.edgeCount,
            [`visualFlows.${i}.layoutSpecVersion`]: layout.layoutSpecVersion,
            [`visualFlows.${i}.updatedAt`]: new Date(),
          },
        }
      );
      updated += 1;
    }
  }

  console.log(dryRun ? `[dry-run] Would update flows` : `Updated ${updated} flow graph(s).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
