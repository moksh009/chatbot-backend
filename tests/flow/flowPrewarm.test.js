'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  warmPublishedFlowGraphCache,
  flattenRuntimeNodes,
} = require('../../utils/flow/flowPrewarm');
const {
  getCachedFlowGraph,
  invalidateFlowGraphCache,
} = require('../../utils/flow/flowGraphCache');
const { resolvePrimaryPublishedFlowId } = require('../../utils/flow/flowGraphResolver');

describe('warmPublishedFlowGraphCache', () => {
  it('stores flattened graph in L1 cache', () => {
    const clientId = 'test_tenant_prewarm';
    invalidateFlowGraphCache(clientId);

    const ok = warmPublishedFlowGraphCache(clientId, {
      flowId: 'flow_primary',
      name: 'Greeting bot',
      publishedNodes: [
        { id: 'n1', type: 'trigger', data: { label: 'Start' } },
        { id: 'n2', type: 'message', data: { text: 'Hi!' } },
      ],
      publishedEdges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    });
    assert.equal(ok, true);

    const cached = getCachedFlowGraph(clientId, 'flow_primary');
    assert.ok(cached?.nodes?.length === 2);
    assert.equal(cached.flowId, 'flow_primary');
    assert.equal(cached.name, 'Greeting bot');
    assert.equal(cached.edges.length, 1);

    invalidateFlowGraphCache(clientId);
  });

  it('returns false when graph has no nodes', () => {
    const clientId = 'test_tenant_empty';
    const ok = warmPublishedFlowGraphCache(clientId, {
      flowId: 'flow_empty',
      publishedNodes: [],
      publishedEdges: [],
    });
    assert.equal(ok, false);
  });
});

describe('flattenRuntimeNodes', () => {
  it('skips editor-only folder nodes', () => {
    const flat = flattenRuntimeNodes([
      { id: 'f1', type: 'folder', children: [{ id: 'm1', type: 'message' }] },
      { id: 'm2', type: 'message' },
    ]);
    assert.deepEqual(flat.map((n) => n.id), ['m1', 'm2']);
  });
});

describe('primary-only prewarm selection', () => {
  it('resolvePrimaryPublishedFlowId picks active visualFlow for warm target', () => {
    const primaryId = resolvePrimaryPublishedFlowId({
      visualFlows: [
        { id: 'flow-a', isActive: false },
        { id: 'flow-b', isActive: true },
      ],
      whatsappFlows: [
        { flowId: 'flow-a', status: 'ARCHIVED', publishedNodes: [{ id: 'x' }] },
        { flowId: 'flow-b', status: 'PUBLISHED', publishedNodes: [{ id: 'y' }] },
      ],
    });
    assert.equal(primaryId, 'flow-b');

    const clientId = 'test_tenant_primary';
    invalidateFlowGraphCache(clientId);
    warmPublishedFlowGraphCache(clientId, {
      flowId: 'flow-b',
      publishedNodes: [{ id: 'y', type: 'message' }],
      publishedEdges: [],
    });
    assert.ok(getCachedFlowGraph(clientId, 'flow-b')?.nodes?.length === 1);
    assert.equal(getCachedFlowGraph(clientId, 'flow-a'), null);
    invalidateFlowGraphCache(clientId);
  });
});
