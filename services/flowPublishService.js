'use strict';

const Client = require('../models/Client');
const WhatsAppFlow = require('../models/WhatsAppFlow');
const { preflightValidateFlowGraph, migrateWarrantyFlowGraph } = require('../utils/flow/flowPublishPreflight');
const { stripEditorOnlyNodes, pruneFlowGraphToReachable } = require('../utils/flow/pruneFlowGraph');
const { sanitizeFlowNodesMedia } = require('../utils/flow/sanitizeFlowMedia');
const { clearTriggerCache } = require('../utils/flow/triggerEngine');
const { clearClientCache } = require('../middleware/apiCache');
const { invalidateFlowGraphCache } = require('../utils/flow/flowGraphCache');
const { warmPublishedFlowGraphCache } = require('../utils/flow/flowPrewarm');
const { emitDual } = require('../utils/core/socketEmit');
const { normalizeFlowAutomationPlatform } = require('../constants/flowAutomationPlatform');
const log = require('../utils/core/logger')('FlowPublish');

async function publishFlowForClient({
  clientId,
  flowId,
  nodes,
  edges,
  publishedBy,
  forcePublish = false,
  io,
}) {
  const client = await Client.findOne({ clientId });
  if (!client) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }

  let flow = flowId
    ? await WhatsAppFlow.findOne({ clientId, flowId })
    : await WhatsAppFlow.findOne({ clientId, status: 'DRAFT' }).sort({ updatedAt: -1 });

  let draftNodes = nodes || flow?.nodes || [];
  let draftEdges = edges || flow?.edges || [];

  const migration = migrateWarrantyFlowGraph({ nodes: draftNodes, edges: draftEdges });
  draftNodes = migration.nodes;
  draftEdges = migration.edges;

  const preflight = preflightValidateFlowGraph({
    nodes: draftNodes,
    edges: draftEdges,
    client: client.toObject ? client.toObject() : client,
  });

  const publishWarnings = [...(migration.warnings || []), ...(preflight.warnings || [])];

  const blockErrors = (preflight.errors || []).filter((e) => e.severity === 'block');
  const bypassableErrors = (preflight.errors || []).filter((e) => e.severity !== 'block');

  if (blockErrors.length > 0) {
    const summary = blockErrors
      .map((e) => `${e.nodeId || 'node'} (${e.code || 'block'})`)
      .join(', ');
    const err = new Error(
      `This flow contains node types not supported in V1. Remove these nodes before publishing: ${summary}`
    );
    err.status = 400;
    err.errors = blockErrors;
    err.warnings = publishWarnings;
    err.blocked = true;
    throw err;
  }

  if (bypassableErrors.length > 0 && !forcePublish) {
    const err = new Error('Flow publish blocked: validation failed.');
    err.status = 400;
    err.errors = bypassableErrors;
    err.warnings = publishWarnings;
    throw err;
  }

  if (!flow) {
    flow = new WhatsAppFlow({
      clientId,
      flowId: flowId || `flow_${Date.now()}`,
      name: 'Published Flow',
      nodes: draftNodes,
      edges: draftEdges,
    });
  } else {
    flow.nodes = draftNodes;
    flow.edges = draftEdges;
  }

  const stripped = stripEditorOnlyNodes(draftNodes, draftEdges);
  const pruned = pruneFlowGraphToReachable(stripped.nodes, stripped.edges);
  flow.publishedNodes = sanitizeFlowNodesMedia(pruned.nodes);
  flow.publishedEdges = pruned.edges;
  flow.status = 'PUBLISHED';
  flow.version = (flow.version || 0) + 1;
  flow.lastSyncedAt = Date.now();
  await flow.save();

  // Single active published flow per tenant — demote others server-side
  await WhatsAppFlow.updateMany(
    { clientId, flowId: { $ne: flow.flowId }, status: 'PUBLISHED' },
    { $set: { status: 'ARCHIVED' } }
  );

  await syncClientFlowGraphStores(client, flow, {
    draftNodes,
    draftEdges,
    publishedNodes: flow.publishedNodes,
    publishedEdges: flow.publishedEdges,
    demoteOtherFlows: true,
  });
  client.publishedFlowVersion = (client.publishedFlowVersion || 0) + 1;
  await client.save();

  clearTriggerCache(clientId);
  await clearClientCache(clientId);
  invalidateFlowGraphCache(clientId, flow.flowId);
  warmPublishedFlowGraphCache(clientId, {
    flowId: flow.flowId,
    name: flow.name,
    publishedNodes: flow.publishedNodes,
    publishedEdges: flow.publishedEdges,
  });

  if (io) {
    emitDual(io, `client_${clientId}`, 'flow_published', {
      flowId: flow.flowId,
      versionNumber: flow.version,
      publishedAt: new Date().toISOString(),
      warnings: publishWarnings,
    });
  }

  return {
    versionNumber: flow.version,
    publishedAt: flow.lastSyncedAt,
    warnings: publishWarnings,
    flowId: flow.flowId,
  };
}

/**
 * FB-P1-08: Align Client.visualFlows card + runtime flowNodes/flowEdges with WhatsAppFlow publish.
 */
async function syncClientFlowGraphStores(client, flow, opts = {}) {
  const { isJourneyBlueprintFlow } = require('../utils/flow/flowGraphResolver');
  if (isJourneyBlueprintFlow(flow)) {
    return;
  }

  const {
    draftNodes = flow.nodes || [],
    draftEdges = flow.edges || [],
    publishedNodes = flow.publishedNodes || [],
    publishedEdges = flow.publishedEdges || [],
    demoteOtherFlows = false,
  } = opts;

  const { resolveFlowListCounts } = require('../utils/flow/flowGraphResolver');
  const draftCounts = resolveFlowListCounts(draftNodes, null, draftEdges, null, {});
  const vf = [...(client.visualFlows || [])];
  const vfIdx = vf.findIndex((v) => String(v.id) === String(flow.flowId));
  const vfPatch = {
    ...(vfIdx >= 0 ? vf[vfIdx] : {}),
    id: flow.flowId,
    name: flow.name || (vfIdx >= 0 ? vf[vfIdx].name : 'Published Flow'),
    platform: normalizeFlowAutomationPlatform(flow.platform),
    folderId: flow.folderId || (vfIdx >= 0 ? vf[vfIdx].folderId : '') || '',
    isActive: true,
    nodes: draftNodes,
    edges: draftEdges,
    nodeCount: draftCounts.nodeCount,
    edgeCount: draftCounts.edgeCount,
    updatedAt: new Date(),
  };
  if (vfIdx >= 0) vf[vfIdx] = vfPatch;
  else vf.push(vfPatch);
  if (demoteOtherFlows) {
    for (let i = 0; i < vf.length; i += 1) {
      if (String(vf[i].id) !== String(flow.flowId)) {
        vf[i] = { ...vf[i], isActive: false };
      }
    }
  }
  client.visualFlows = vf;
  client.flowNodes = publishedNodes;
  client.flowEdges = publishedEdges;
  client.markModified('visualFlows');
}

module.exports = { publishFlowForClient, syncClientFlowGraphStores };
