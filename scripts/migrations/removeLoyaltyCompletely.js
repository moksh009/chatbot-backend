#!/usr/bin/env node
"use strict";

/**
 * One-time cleanup: remove all loyalty data and strip loyalty nodes from saved flows.
 *
 * Usage:
 *   node scripts/migrations/removeLoyaltyCompletely.js
 *   node scripts/migrations/removeLoyaltyCompletely.js --dry-run
 */

const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const Client = require("../../models/Client");
const AdLead = require("../../models/AdLead");
const FollowUpSequence = require("../../models/FollowUpSequence");

const DRY_RUN = process.argv.includes("--dry-run");

const LOYALTY_NODE_TYPES = new Set(["loyalty_action", "loyalty", "LoyaltyActionNode"]);

function stripLoyaltyFromFlow(flow) {
  if (!flow || !Array.isArray(flow.nodes)) return { flow, removedNodes: 0, removedEdges: 0 };
  const nodes = flow.nodes || [];
  const edges = flow.edges || [];
  const dropIds = new Set(
    nodes.filter((n) => LOYALTY_NODE_TYPES.has(String(n?.type || ""))).map((n) => n.id)
  );
  if (!dropIds.size) return { flow, removedNodes: 0, removedEdges: 0 };

  const nextNodes = nodes.filter((n) => !dropIds.has(n.id));
  const nextEdges = edges.filter((e) => !dropIds.has(e.source) && !dropIds.has(e.target));
  return {
    flow: { ...flow, nodes: nextNodes, edges: nextEdges },
    removedNodes: dropIds.size,
    removedEdges: edges.length - nextEdges.length,
  };
}

function stripAllFlows(visualFlows) {
  if (!Array.isArray(visualFlows)) return { flows: visualFlows, stats: { flows: 0, nodes: 0, edges: 0 } };
  let nodes = 0;
  let edges = 0;
  let flows = 0;
  const out = visualFlows.map((f) => {
    const { flow, removedNodes, removedEdges } = stripLoyaltyFromFlow(f);
    if (removedNodes) {
      flows += 1;
      nodes += removedNodes;
      edges += removedEdges;
    }
    return flow;
  });
  return { flows: out, stats: { flows, nodes, edges } };
}

async function dropCollection(db, name) {
  const collections = await db.listCollections({ name }).toArray();
  if (!collections.length) {
    console.log(`  skip drop ${name} (not found)`);
    return;
  }
  if (DRY_RUN) {
    const count = await db.collection(name).countDocuments();
    console.log(`  [dry-run] would drop ${name} (${count} docs)`);
    return;
  }
  await db.collection(name).drop();
  console.log(`  dropped ${name}`);
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI missing");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 120000 });
  const db = mongoose.connection.db;
  console.log(DRY_RUN ? "DRY RUN — no writes" : "Removing loyalty completely…");

  await dropCollection(db, "customerwallets");
  await dropCollection(db, "loyaltytransactions");

  const clientUnset = {
    loyaltyConfig: "",
    "wizardFeatures.enableLoyalty": "",
    "wizardFeatures.loyaltySendReminders": "",
    "wizardFeatures.loyaltyReminderDaysBeforeExpiry": "",
    "wizardFeatures.loyaltyPointsPerUnit": "",
    "wizardFeatures.loyaltySignupBonus": "",
    "wizardFeatures.loyaltySilverThreshold": "",
    "wizardFeatures.loyaltyGoldThreshold": "",
  };

  const leadUnset = {
    loyaltyPoints: "",
    loyaltyTier: "",
    loyaltyExpiresAt: "",
    loyaltyReminderSentAt: "",
  };

  const clientsCol = db.collection("clients");
  const leadsCol = db.collection("adleads");
  const seqCol = db.collection("followupsequences");

  if (DRY_RUN) {
    const wc = await db.collection("customerwallets").countDocuments().catch(() => 0);
    const lt = await db.collection("loyaltytransactions").countDocuments().catch(() => 0);
    const clients = await clientsCol.countDocuments({
      $or: [{ loyaltyConfig: { $exists: true } }, { "wizardFeatures.enableLoyalty": true }],
    });
    const leads = await leadsCol.countDocuments({ loyaltyPoints: { $gt: 0 } });
    console.log(`  [dry-run] clients with loyalty flags: ${clients}`);
    console.log(`  [dry-run] leads with loyaltyPoints > 0: ${leads}`);
    console.log(`  [dry-run] wallet/ledger collections: ${wc} / ${lt}`);
  } else {
    const cr = await clientsCol.updateMany({}, { $unset: clientUnset });
    const lr = await leadsCol.updateMany({}, { $unset: leadUnset });
    console.log(`  clients updated: ${cr.modifiedCount}`);
    console.log(`  leads updated: ${lr.modifiedCount}`);

    const seqType = await seqCol.updateMany(
      { type: "loyalty_reminder" },
      { $set: { type: "custom" } }
    );
    const seqSteps = await seqCol.updateMany(
      { "steps.type": "loyalty_reminder" },
      { $set: { "steps.$[s].type": "whatsapp" } },
      { arrayFilters: [{ "s.type": "loyalty_reminder" }] }
    );
    console.log(`  sequences type loyalty_reminder → custom: ${seqType.modifiedCount}`);
    console.log(`  sequence steps loyalty_reminder → whatsapp: ${seqSteps.modifiedCount}`);
  }

  const clients = await clientsCol
    .find({ visualFlows: { $exists: true, $ne: [] } })
    .project({ clientId: 1, visualFlows: 1 })
    .toArray();

  let flowClients = 0;
  let removedNodes = 0;
  let removedEdges = 0;

  for (const c of clients) {
    const { flows, stats } = stripAllFlows(c.visualFlows);
    if (!stats.nodes) continue;
    flowClients += 1;
    removedNodes += stats.nodes;
    removedEdges += stats.edges;
    if (!DRY_RUN) {
      await clientsCol.updateOne({ clientId: c.clientId }, { $set: { visualFlows: flows } });
    }
  }

  console.log(
    `  visualFlows scrubbed: ${flowClients} clients, ${removedNodes} loyalty nodes, ${removedEdges} edges removed`
  );

  const waFlowsCol = db.collection("whatsappflows");
  let waFlowDocs = 0;
  let waRemovedNodes = 0;
  let waRemovedEdges = 0;
  const waFlows = await waFlowsCol
    .find({ nodes: { $exists: true, $ne: [] } })
    .project({ flowId: 1, clientId: 1, nodes: 1, edges: 1 })
    .toArray();

  for (const doc of waFlows) {
    const { flow, removedNodes: rn, removedEdges: re } = stripLoyaltyFromFlow({
      nodes: doc.nodes,
      edges: doc.edges,
    });
    if (!rn) continue;
    waFlowDocs += 1;
    waRemovedNodes += rn;
    waRemovedEdges += re;
    if (!DRY_RUN) {
      await waFlowsCol.updateOne(
        { _id: doc._id },
        { $set: { nodes: flow.nodes, edges: flow.edges } }
      );
    }
  }

  console.log(
    `  whatsappflows scrubbed: ${waFlowDocs} docs, ${waRemovedNodes} loyalty nodes, ${waRemovedEdges} edges removed`
  );

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
