'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { shouldSkipSacForNdr } = require('../utils/commerce/rtoProtectionService');

describe('shouldSkipSacForNdr', () => {
  const client = { rtoProtection: { enableNdrRescue: true } };

  it('skips SAC when NDR rescue succeeded', () => {
    assert.equal(shouldSkipSacForNdr(client, 'attempted_delivery', { ok: true }), true);
  });

  it('does not skip SAC when NDR rescue failed', () => {
    assert.equal(shouldSkipSacForNdr(client, 'failure', { ok: false, error: 'template' }), false);
  });

  it('does not skip SAC when NDR rescue is disabled', () => {
    const off = { rtoProtection: { enableNdrRescue: false } };
    assert.equal(shouldSkipSacForNdr(off, 'attempted_delivery', { ok: true }), false);
  });

  it('skips SAC for non-NDR statuses', () => {
    assert.equal(shouldSkipSacForNdr(client, 'delivered', { ok: true }), false);
  });
});
