'use strict';

const Client = require('../../models/Client');
const log = require('../../utils/core/logger')('JourneyFlowHandoff');
const { runFlow } = require('../../utils/commerce/dualBrainEngine');
const { findFlowStartNode } = require('../../utils/flow/triggerEngine');
const {
  resolveFlowGraphByRef,
  resolvePrimaryFlowGraph,
  flattenFlowNodes,
} = require('../../utils/flow/flowGraphResolver');
const { invalidateFlowGraphCache } = require('../../utils/flow/flowGraphCache');

async function flowHasPublishedGraph(clientId, flowRef, clientLean) {
  const WhatsAppFlow = require('../../models/WhatsAppFlow');
  const doc = await WhatsAppFlow.findOne({ clientId, flowId: flowRef })
    .select('publishedNodes status')
    .lean();
  const vf = (clientLean?.visualFlows || []).find((v) => String(v.id) === String(flowRef));
  return (
    (doc?.publishedNodes?.length || 0) > 0 ||
    doc?.status === 'PUBLISHED' ||
    !!vf?.isActive
  );
}

/**
 * Hand journey enrollment control to a published Flow Builder flow.
 * Loads the latest published graph (not a frozen snapshot from journey publish).
 */
async function executeJourneyFlowHandoff({
  clientId,
  phone,
  targetFlowId,
  sequenceId = '',
}) {
  if (!clientId || !phone) {
    throw new Error('Missing clientId or phone');
  }

  const client = await Client.findOne({ clientId }).lean();
  if (!client) throw new Error('Client not found');

  let flowRef = String(targetFlowId || '').trim();
  if (!flowRef) {
    const primary = await resolvePrimaryFlowGraph(clientId);
    flowRef = primary?.id ? String(primary.id) : '';
  }
  if (!flowRef) {
    throw new Error('No target flow for chatbot handoff — publish a flow in Flow Builder');
  }

  invalidateFlowGraphCache(clientId, flowRef);

  const resolved = await resolveFlowGraphByRef(clientId, flowRef);
  if (!resolved?.nodes?.length) {
    throw new Error(`Flow ${flowRef} not found or has no published nodes`);
  }

  const published = await flowHasPublishedGraph(clientId, flowRef, client);
  if (!published) {
    throw new Error(
      `Flow not published — publish "${resolved.name || flowRef}" in Flow Builder before handoff runs`
    );
  }

  const flowNodes = flattenFlowNodes(resolved.nodes);
  const flowEdges = resolved.edges || [];
  const startNodeId = findFlowStartNode(flowNodes, flowEdges);
  if (!startNodeId) {
    throw new Error(`Flow ${flowRef} has no trigger/start node`);
  }

  const flowId = resolved.id || flowRef;
  log.info(
    `[JourneyFlowHandoff] seq=${sequenceId} phone=${phone} → flow ${flowId} (${resolved.name || 'unnamed'})`
  );

  await runFlow(
    client,
    phone,
    {
      id: flowId,
      name: resolved.name || '',
      nodes: flowNodes,
      edges: flowEdges,
    },
    startNodeId,
    {
      triggerSource: 'journey_handoff',
      journeySequenceId: sequenceId ? String(sequenceId) : undefined,
    }
  );

  return { flowId, startNodeId };
}

module.exports = { executeJourneyFlowHandoff, flowHasPublishedGraph };
