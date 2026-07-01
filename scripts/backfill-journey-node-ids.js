/**
 * backfill-journey-node-ids.js
 *
 * One-time migration: for every FollowUpSequence whose steps are missing
 * graphNodeId, reconstruct the nodeId from the published journey graph and
 * write it back to MongoDB.
 *
 * Algorithm:
 *   1. Walk published graph from JOURNEY_TRIGGER using the same logic as
 *      JourneyAnalyticsOverlay.buildJourneyAnalyticsNodeMap (ported to Node).
 *   2. Build stepIndex → nodeId map for send-type nodes only.
 *   3. For each step at that stepIndex, write steps.N.graphNodeId.
 *   4. Mark steps.N.graphNodeIdSource = 'backfilled' so callers can distinguish
 *      exact (set at compile time) vs best-effort (set by this script).
 *
 * Usage:
 *   node scripts/backfill-journey-node-ids.js [clientId] [--dry-run]
 *   node scripts/backfill-journey-node-ids.js delitech_smarthomes --dry-run
 *   node scripts/backfill-journey-node-ids.js delitech_smarthomes
 *   node scripts/backfill-journey-node-ids.js          # all clients
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const JOURNEY_NODE_TYPES = Object.freeze({
  JOURNEY_TRIGGER: 'journey_trigger',
  SEND_WHATSAPP: 'send_whatsapp',
  SEND_EMAIL: 'send_email',
  CHATBOT_HANDOFF: 'chatbot_handoff',
  WAIT: 'wait',
  CONDITION: 'condition',
  CONDITIONAL_SPLIT: 'conditional_split',
  END: 'end',
});

const SEND_TYPES = new Set([
  JOURNEY_NODE_TYPES.SEND_WHATSAPP,
  JOURNEY_NODE_TYPES.SEND_EMAIL,
  JOURNEY_NODE_TYPES.CHATBOT_HANDOFF,
]);

function nodeTypeOf(node) {
  return String(node?.type || node?.data?.nodeType || '').trim();
}

function buildAdjacency(edges = []) {
  const out = new Map();
  for (const e of edges || []) {
    if (!e?.source) continue;
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e);
  }
  return out;
}

function pickDefaultEdge(edges) {
  if (!edges?.length) return null;
  return edges.find((e) => e.sourceHandle === 'default' || !e.sourceHandle) || edges[0];
}

/**
 * Walk the published graph and return a Map<nodeId, stepIndex> for send nodes.
 * Mirrors the frontend buildJourneyAnalyticsNodeMap in JourneyAnalyticsOverlay.jsx.
 */
function buildNodeToStepIndexMap(nodes = [], edges = []) {
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  const adj = buildAdjacency(edges);
  const trigger = (nodes || []).find((n) => nodeTypeOf(n) === JOURNEY_NODE_TYPES.JOURNEY_TRIGGER);
  if (!trigger) return new Map();

  const map = new Map(); // nodeId → stepIndex
  let stepIndex = 0;
  let pendingGate = [];
  let currentId = trigger.id;
  const visited = new Set();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const outs = adj.get(currentId) || [];
    const edge = pickDefaultEdge(outs);
    if (!edge?.target) break;
    const node = byId.get(edge.target);
    if (!node) break;

    const type = nodeTypeOf(node);
    if (type === JOURNEY_NODE_TYPES.END) break;

    if (type === JOURNEY_NODE_TYPES.WAIT || type === JOURNEY_NODE_TYPES.CONDITION) {
      pendingGate.push(node.id);
      currentId = node.id;
      continue;
    }

    if (SEND_TYPES.has(type)) {
      map.set(node.id, stepIndex);
      // gate nodes (wait/condition before this send) also map to same stepIndex
      for (const gid of pendingGate) {
        map.set(gid, stepIndex);
      }
      pendingGate = [];
      stepIndex += 1;
      currentId = node.id;
      continue;
    }

    currentId = node.id;
  }

  return map;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const clientId = args.find((a) => !a.startsWith('--')) || null;

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('Connected to MongoDB\n');

  const FollowUpSequence = require('../models/FollowUpSequence');
  const WhatsAppFlow = require('../models/WhatsAppFlow');

  const clientFilter = clientId ? { clientId } : {};

  // Load all published journeys into a map for fast lookup
  const flows = await WhatsAppFlow.find({
    ...clientFilter,
    flowType: 'journey',
  })
    .select('flowId clientId publishedNodes publishedEdges nodes edges')
    .lean();

  const flowMap = new Map(flows.map((f) => [f.flowId, f]));
  console.log(`Loaded ${flows.length} journey blueprints`);

  // Find sequences that have at least one step with missing/empty graphNodeId.
  // Pre-existing steps have the field undefined (not in BSON), not '' — so we
  // match on { $exists: false } OR '' OR null to cover all cases.
  const seqs = await FollowUpSequence.find({
    ...clientFilter,
    sourceFlowId: { $ne: '' },
    steps: {
      $elemMatch: {
        $or: [
          { graphNodeId: { $exists: false } },
          { graphNodeId: null },
          { graphNodeId: '' },
        ],
      },
    },
  })
    .select('clientId sourceFlowId steps')
    .lean();

  console.log(`Found ${seqs.length} sequences with missing graphNodeId\n`);

  let totalUpdated = 0;
  let totalStepsBackfilled = 0;
  const notFound = new Set();

  for (const seq of seqs) {
    const flow = flowMap.get(seq.sourceFlowId);
    if (!flow) {
      notFound.add(seq.sourceFlowId);
      continue;
    }

    const nodes = flow.publishedNodes?.length ? flow.publishedNodes : flow.nodes || [];
    const edges = flow.publishedEdges?.length ? flow.publishedEdges : flow.edges || [];
    const nodeToStep = buildNodeToStepIndexMap(nodes, edges);

    if (!nodeToStep.size) continue;

    // Invert: stepIndex → nodeId
    const stepToNode = new Map();
    for (const [nodeId, stepIdx] of nodeToStep.entries()) {
      // Only record SEND-type nodes (not gates) for step assignment
      const nodeType = nodeTypeOf(nodes.find((n) => n.id === nodeId));
      if (SEND_TYPES.has(nodeType)) {
        stepToNode.set(stepIdx, nodeId);
      }
    }

    const $set = {};
    let changed = false;

    (seq.steps || []).forEach((step, idx) => {
      if (step.graphNodeId) return; // already set (non-empty string), skip
      const nodeId = stepToNode.get(idx);
      if (!nodeId) return;
      $set[`steps.${idx}.graphNodeId`] = nodeId;
      $set[`steps.${idx}.graphNodeIdSource`] = 'backfilled';
      changed = true;
      totalStepsBackfilled += 1;
    });

    if (!changed) continue;

    console.log(`  ${dryRun ? '[dry-run] ' : ''}seq=${seq._id} flow=${seq.sourceFlowId} → ${Object.keys($set).length / 2} steps backfilled`);
    if (!dryRun) {
      await FollowUpSequence.updateOne({ _id: seq._id }, { $set });
    }
    totalUpdated += 1;
  }

  if (notFound.size) {
    console.log(`\n⚠  ${notFound.size} sourceFlowIds had no matching blueprint (may be deleted):`);
    for (const fid of notFound) console.log(`    ${fid}`);
  }

  console.log(`\n=== ${dryRun ? '[DRY RUN] ' : ''}Summary ===`);
  console.log(`Sequences updated: ${totalUpdated}`);
  console.log(`Steps backfilled:  ${totalStepsBackfilled}`);
  if (dryRun) console.log('No writes performed — re-run without --dry-run to apply.');

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
