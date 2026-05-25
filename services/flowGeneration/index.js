'use strict';

const Client = require('../../models/Client');
const { publishFlowForClient } = require('../flowPublishService');
const log = require('../../utils/core/logger')('FlowGeneration');

/**
 * Canonical AI flow generation (Phase 4 Module 6).
 * Persists to visualFlows draft — never writes publishedNodes directly.
 */
async function generateFlow({
  clientId,
  intent = 'in_canvas_build',
  industry,
  brandName,
  goals = [],
  languages = ['en'],
  existingFlowId,
  promptOverride,
  autoPublish = false,
  user,
  io,
}) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error('client_not_found');

  const draftId = existingFlowId || `vf_${Date.now()}`;
  const flows = Array.isArray(client.visualFlows) ? [...client.visualFlows] : [];
  let idx = flows.findIndex((f) => String(f.id) === String(draftId));

  const seedNodes = [
    {
      id: 'start',
      type: 'trigger',
      data: { label: 'Start', triggerType: 'keyword', keywords: ['hi', 'hello'] },
      position: { x: 0, y: 0 },
    },
    {
      id: 'welcome',
      type: 'message',
      data: {
        label: 'Welcome',
        message: promptOverride || `Welcome to ${brandName || client.businessName || 'our store'}!`,
      },
      position: { x: 280, y: 0 },
    },
  ];
  const seedEdges = [{ id: 'e1', source: 'start', target: 'welcome' }];

  const draft = {
    id: draftId,
    name: `${brandName || 'AI'} Flow`,
    platform: 'whatsapp',
    isActive: intent === 'wizard_complete',
    status: 'DRAFT',
    industry: industry || client.industry,
    goals,
    languages,
    draftNodes: seedNodes,
    draftEdges: seedEdges,
    nodes: seedNodes,
    edges: seedEdges,
    updatedAt: new Date(),
    generatedBy: intent,
  };

  if (idx >= 0) flows[idx] = { ...flows[idx], ...draft };
  else flows.push(draft);

  client.visualFlows = flows;
  client.markModified('visualFlows');
  await client.save();

  let published = null;
  const preflightWarnings = [];
  if (autoPublish) {
    try {
      published = await publishFlowForClient({
        clientId,
        flowId: draftId,
        nodes: seedNodes,
        edges: seedEdges,
        publishedBy: user?.email || user?.name || 'flow_generate',
        io,
      });
    } catch (e) {
      log.warn(`autoPublish rejected: ${e.message}`);
      preflightWarnings.push(e.message);
    }
  }

  return {
    flowId: draftId,
    draftNodes: seedNodes,
    draftEdges: seedEdges,
    preflightWarnings,
    published,
    intent,
  };
}

module.exports = { generateFlow };
