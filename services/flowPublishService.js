'use strict';

const Client = require('../models/Client');
const WhatsAppFlow = require('../models/WhatsAppFlow');
const FlowHistory = require('../models/FlowHistory');
const { preflightValidateFlowGraph } = require('../utils/flow/flowPublishPreflight');
const { stripEditorOnlyNodes, pruneFlowGraphToReachable } = require('../utils/flow/pruneFlowGraph');
const { sanitizeFlowNodesMedia } = require('../utils/flow/sanitizeFlowMedia');
const { clearTriggerCache } = require('../utils/flow/triggerEngine');
const { clearClientCache, invalidateClientCache } = require('../utils/core/clientCache');
const { invalidateFlowGraphCache } = require('../utils/flow/flowGraphCache');
const { emitDual } = require('../utils/core/socketEmit');
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

  const draftNodes = nodes || flow?.nodes || [];
  const draftEdges = edges || flow?.edges || [];

  const preflight = preflightValidateFlowGraph({
    nodes: draftNodes,
    edges: draftEdges,
    client: client.toObject ? client.toObject() : client,
  });

  if (!preflight.valid && !forcePublish) {
    const err = new Error('Flow publish blocked: validation failed.');
    err.status = 400;
    err.errors = preflight.errors;
    err.warnings = preflight.warnings;
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

  if (flow.publishedNodes?.length) {
    await FlowHistory.create({
      clientId,
      flowId: flow.flowId,
      version: flow.version,
      nodes: flow.publishedNodes,
      edges: flow.publishedEdges,
      publishedBy: publishedBy || 'system',
    });
  }

  const stripped = stripEditorOnlyNodes(draftNodes, draftEdges);
  const pruned = pruneFlowGraphToReachable(stripped.nodes, stripped.edges);
  flow.publishedNodes = sanitizeFlowNodesMedia(pruned.nodes);
  flow.publishedEdges = pruned.edges;
  flow.status = 'PUBLISHED';
  flow.version = (flow.version || 0) + 1;
  flow.lastSyncedAt = Date.now();
  await flow.save();

  client.publishedFlowVersion = (client.publishedFlowVersion || 0) + 1;
  await client.save();

  clearTriggerCache(clientId);
  await clearClientCache(clientId);
  invalidateClientCache(clientId);
  invalidateFlowGraphCache(clientId, flow.flowId);

  if (io) {
    emitDual(io, `client_${clientId}`, 'flow_published', {
      flowId: flow.flowId,
      versionNumber: flow.version,
      publishedAt: new Date().toISOString(),
      warnings: preflight.warnings || [],
    });
  }

  return {
    versionNumber: flow.version,
    publishedAt: flow.lastSyncedAt,
    warnings: preflight.warnings || [],
    flowId: flow.flowId,
  };
}

module.exports = { publishFlowForClient };
