'use strict';

const assert = require('assert');
const { validatePlan, ENTITY_WHITELIST } = require('../../services/bi/queryPlanner');
const { buildMatch } = require('../../services/bi/queryExecutor');

function testValidPlan() {
  const plan = validatePlan({
    entity: 'orders',
    metric: 'sum',
    metricField: 'amount',
    filters: [{ field: 'status', op: 'eq', value: 'delivered' }],
    limit: 10,
  });
  assert.strictEqual(plan.entity, 'orders');
}

function testRejectEntity() {
  let threw = false;
  try {
    validatePlan({ entity: 'users', metric: 'count', filters: [] });
  } catch (e) {
    threw = true;
    assert.ok(e.message.includes('not allowed'));
  }
  assert.ok(threw);
}

function testAdversarialField() {
  let threw = false;
  try {
    validatePlan({
      entity: 'leads',
      metric: 'count',
      filters: [{ field: '$where', op: 'eq', value: '1==1' }],
    });
  } catch (e) {
    threw = true;
  }
  assert.ok(threw);
}

function testTenantIsolation() {
  const match = buildMatch('tenant_a', { entity: 'orders', filters: [], metric: 'count' });
  assert.strictEqual(match.clientId, 'tenant_a');
}

function testCrossTenant() {
  const a = buildMatch('client_a', { filters: [], metric: 'count' });
  const b = buildMatch('client_b', { filters: [], metric: 'count' });
  assert.notStrictEqual(a.clientId, b.clientId);
}

testValidPlan();
testRejectEntity();
testAdversarialField();
testTenantIsolation();
testCrossTenant();
console.log('phase9 biSandbox.test.js: OK');
