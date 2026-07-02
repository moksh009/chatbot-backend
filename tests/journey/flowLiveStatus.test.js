'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeFlowsListForDashboard,
  resolvePrimaryPublishedFlowId,
} = require('../../utils/flow/flowGraphResolver');

describe('resolvePrimaryPublishedFlowId', () => {
  it('prefers visualFlows isActive', () => {
    const id = resolvePrimaryPublishedFlowId({
      visualFlows: [
        { id: 'flow-a', isActive: false },
        { id: 'flow-b', isActive: true },
      ],
      whatsappFlows: [{ flowId: 'flow-a', status: 'PUBLISHED' }],
    });
    assert.equal(id, 'flow-b');
  });

  it('falls back to sole PUBLISHED WhatsAppFlow', () => {
    const id = resolvePrimaryPublishedFlowId({
      visualFlows: [],
      whatsappFlows: [{ flowId: 'flow-live', status: 'PUBLISHED' }],
    });
    assert.equal(id, 'flow-live');
  });

  it('picks latest when multiple PUBLISHED (corrupt state)', () => {
    const id = resolvePrimaryPublishedFlowId({
      visualFlows: [],
      whatsappFlows: [
        { flowId: 'old', status: 'PUBLISHED', lastSyncedAt: new Date('2026-01-01') },
        { flowId: 'new', status: 'PUBLISHED', lastSyncedAt: new Date('2026-06-01') },
      ],
    });
    assert.equal(id, 'new');
  });
});

describe('mergeFlowsListForDashboard live status', () => {
  it('only primary flow is live — ARCHIVED with publishedNodes is not live', () => {
    const dbFlows = [
      {
        flowId: 'flow-live',
        name: 'Live bot',
        status: 'PUBLISHED',
        publishedNodes: [{ id: 'n1', type: 'trigger' }],
        publishedEdges: [],
        nodes: [],
        edges: [],
        lastSyncedAt: new Date('2026-06-02'),
      },
      {
        flowId: 'flow-old',
        name: 'Old bot',
        status: 'ARCHIVED',
        publishedNodes: [{ id: 'n2', type: 'trigger' }],
        publishedEdges: [],
        nodes: [],
        edges: [],
        lastSyncedAt: new Date('2026-05-01'),
      },
    ];
    const visualFlows = [
      { id: 'flow-live', name: 'Live bot', isActive: true, nodes: [{ id: 'n1', type: 'trigger' }] },
      { id: 'flow-old', name: 'Old bot', isActive: false, nodes: [{ id: 'n2', type: 'trigger' }] },
    ];
    const { flows } = mergeFlowsListForDashboard(dbFlows, visualFlows, [], [], []);
    const live = flows.filter((f) => f.isActive);
    assert.equal(live.length, 1);
    assert.equal(live[0].id, 'flow-live');
    const archived = flows.find((f) => f.id === 'flow-old');
    assert.equal(archived.isActive, false);
    assert.equal(archived.status, 'ARCHIVED');
  });

  it('does not mark live from publishedNodes alone when status is DRAFT', () => {
    const dbFlows = [
      {
        flowId: 'flow-1',
        name: 'Main bot',
        status: 'DRAFT',
        publishedNodes: [{ id: 'n1', type: 'trigger' }],
        publishedEdges: [],
        nodes: [],
        edges: [],
      },
    ];
    const { flows } = mergeFlowsListForDashboard(dbFlows, [], [], [], []);
    assert.equal(flows[0].isActive, false);
    assert.equal(flows[0].status, 'DRAFT');
  });

  it('does not promote stale visualFlow isActive when another flow is primary in DB', () => {
    const dbFlows = [
      { flowId: 'flow-a', name: 'A', status: 'PUBLISHED', nodes: [], edges: [], lastSyncedAt: new Date() },
      { flowId: 'flow-b', name: 'B', status: 'ARCHIVED', nodes: [], edges: [] },
    ];
    const visualFlows = [
      { id: 'flow-a', name: 'A', isActive: true, nodes: [] },
      { id: 'flow-b', name: 'B', isActive: true, nodes: [] },
    ];
    const { flows } = mergeFlowsListForDashboard(dbFlows, visualFlows, [], [], []);
    const live = flows.filter((f) => f.isActive);
    assert.equal(live.length, 1);
    assert.equal(live[0].id, 'flow-a');
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
