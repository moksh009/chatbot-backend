'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeFlowsListForDashboard,
} = require('../../utils/flow/flowGraphResolver');

describe('mergeFlowsListForDashboard live status', () => {
  it('marks flow live when publishedNodes exist but status is DRAFT', () => {
    const dbFlows = [
      {
        flowId: 'flow-1',
        name: 'Main bot',
        status: 'DRAFT',
        publishedNodes: [{ id: 'n1', type: 'trigger' }],
        publishedEdges: [],
        nodes: [{ id: 'n1-draft', type: 'trigger' }],
        edges: [],
      },
    ];
    const { flows } = mergeFlowsListForDashboard(dbFlows, [], [], [], []);
    assert.equal(flows.length, 1);
    assert.equal(flows[0].status, 'PUBLISHED');
    assert.equal(flows[0].isActive, true);
  });

  it('marks flow live when visualFlow isActive even if db status is DRAFT', () => {
    const dbFlows = [
      {
        flowId: 'flow-2',
        name: 'Store bot',
        status: 'DRAFT',
        nodes: [{ id: 'a', type: 'trigger' }],
        edges: [],
      },
    ];
    const visualFlows = [{ id: 'flow-2', name: 'Store bot', isActive: true, nodes: [{ id: 'a', type: 'trigger' }] }];
    const { flows } = mergeFlowsListForDashboard(dbFlows, visualFlows, [], [], []);
    assert.equal(flows[0].status, 'PUBLISHED');
    assert.equal(flows[0].isActive, true);
  });
});

describe('pickGraphFromFlowDoc published preference', () => {
  it('prefers publishedNodes over draft nodes', () => {
    const { pickGraphFromFlowDoc } = require('../../utils/flow/flowGraphResolver');
    const graph = pickGraphFromFlowDoc({
      status: 'PUBLISHED',
      publishedNodes: [{ id: 'pub', type: 'message', data: { label: 'Published' } }],
      nodes: [{ id: 'draft', type: 'message', data: { label: 'Draft' } }],
      edges: [],
    });
    assert.ok(graph);
    assert.equal(graph.fromPublished, true);
    assert.equal(graph.nodes[0].id, 'pub');
  });
});
