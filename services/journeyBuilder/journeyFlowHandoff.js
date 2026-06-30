'use strict';

const Client = require('../../models/Client');
const log = require('../../utils/core/logger')('JourneyFlowHandoff');
const {
  loadPublishedFlowByRef,
  runFlow,
} = require('../../utils/commerce/dualBrainEngine');
const { findFlowStartNode } = require('../../utils/flow/triggerEngine');
const { flattenFlowNodes } = require('../../utils/flow/flowGraphResolver');

/**
 * Hand journey enrollment control to a published Flow Builder flow.
 * Sets conversation activeFlowId and runs the flow trigger node.
 */
async function executeJourneyFlowHandoff({
  clientId,
  phone,
  targetFlowId,
  sequenceId = '',
}) {
  if (!clientId || !phone || !targetFlowId) {
    throw new Error('Missing clientId, phone, or targetFlowId');
  }

  const client = await Client.findOne({ clientId }).lean();
  if (!client) throw new Error('Client not found');

  const loaded = await loadPublishedFlowByRef(clientId, String(targetFlowId));
  if (!loaded?.nodes?.length) {
    throw new Error(`Flow ${targetFlowId} not found or has no published nodes`);
  }

  const flowNodes = flattenFlowNodes(loaded.nodes);
  const flowEdges = loaded.edges || [];
  const startNodeId = findFlowStartNode(flowNodes, flowEdges);
  if (!startNodeId) {
    throw new Error(`Flow ${targetFlowId} has no trigger/start node`);
  }

  const flowRef = loaded.id || String(targetFlowId);
  log.info(
    `[JourneyFlowHandoff] seq=${sequenceId} phone=${phone} → flow ${flowRef} (${loaded.name || 'unnamed'})`
  );

  await runFlow(
    client,
    phone,
    {
      id: flowRef,
      name: loaded.name || '',
      nodes: flowNodes,
      edges: flowEdges,
    },
    startNodeId,
    {
      triggerSource: 'journey_handoff',
      journeySequenceId: sequenceId ? String(sequenceId) : undefined,
    }
  );

  return { flowId: flowRef, startNodeId };
}

module.exports = { executeJourneyFlowHandoff };
