'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { preflightValidateFlowGraph } = require('../../utils/flow/flowPublishPreflight');

test('preflight warns when shopify_call CHECK_ORDER_STATUS has no fail branch', () => {
  const nodes = [
    { id: 'n1', type: 'shopify_call', data: { action: 'CHECK_ORDER_STATUS' } },
    { id: 'n2', type: 'message', data: { text: 'ok' } },
  ];
  const edges = [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'success' }];
  const { warnings } = preflightValidateFlowGraph({ nodes, edges, client: {} });
  assert.ok(warnings.some((w) => w.code === 'SHOPIFY_ORDER_LOOKUP_NO_FALLBACK'));
});

test('preflight accepts ORDER_STATUS alias for branch check', () => {
  const nodes = [
    { id: 'n1', type: 'shopify_call', data: { action: 'ORDER_STATUS' } },
    { id: 'n2', type: 'message', data: { text: 'miss' } },
  ];
  const edges = [
    { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'not_found' },
  ];
  const { warnings } = preflightValidateFlowGraph({ nodes, edges, client: {} });
  assert.ok(!warnings.some((w) => w.code === 'SHOPIFY_ORDER_LOOKUP_NO_FALLBACK'));
});
