'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { verifySecret } = require('../../utils/audience/thirdPartyCheckoutHandler');

test('verifySecret accepts matching header', () => {
  const req = { headers: { 'x-webhook-secret': 'abc' }, body: {} };
  assert.strictEqual(verifySecret(req, 'abc'), true);
});

test('verifySecret accepts body secret', () => {
  const req = { headers: {}, body: { secret: 'xyz' } };
  assert.strictEqual(verifySecret(req, 'xyz'), true);
});

test('verifySecret skips when no secret configured', () => {
  const req = { headers: {}, body: {} };
  assert.strictEqual(verifySecret(req, ''), true);
});
