'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateUniqueCode } = require('../../services/optInCouponService');

describe('optInCouponService', () => {
  it('generateUniqueCode uses TOPEDGE prefix format', () => {
    const code = generateUniqueCode('abc123def456');
    assert.match(code, /^TOPEDGE-[A-Z0-9]+-[A-Z0-9]+$/);
  });
});
