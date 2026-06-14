'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveUsageLimit,
  deriveDiscountStatus,
} = require('../utils/commerce/discountCodes');

describe('discountCodes', () => {
  it('resolveUsageLimit modes', () => {
    assert.equal(resolveUsageLimit('single', null).usageLimit, 1);
    assert.equal(resolveUsageLimit('limited', 5).usageLimit, 5);
    assert.equal(resolveUsageLimit('unlimited').usageLimit, null);
  });

  it('deriveDiscountStatus', () => {
    assert.equal(deriveDiscountStatus({ disabledAt: new Date() }), 'disabled');
    assert.equal(
      deriveDiscountStatus({ endsAt: new Date(Date.now() - 1000).toISOString() }),
      'expired'
    );
    assert.equal(deriveDiscountStatus({ expiryMode: 'never', endsAt: null }), 'active');
    assert.equal(
      deriveDiscountStatus({ usageLimit: 1, usageCount: 1 }),
      'used_up'
    );
    assert.equal(deriveDiscountStatus({ usageLimit: 5, usageCount: 2 }), 'active');
  });
});
