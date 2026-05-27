'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOrderPhoneQuery } = require('../utils/customer360/leadLookupHelpers');

test('buildOrderPhoneQuery matches phone and customerPhone variants', () => {
  const q = buildOrderPhoneQuery('client_a', '919876543210');
  assert.equal(q.clientId, 'client_a');
  assert.ok(Array.isArray(q.$or));
  assert.equal(q.$or.length, 2);
  assert.deepEqual(q.$or[0].phone.$in, q.$or[1].customerPhone.$in);
  assert.ok(q.$or[0].phone.$in.includes('919876543210'));
  assert.ok(q.$or[0].phone.$in.includes('9876543210'));
});
