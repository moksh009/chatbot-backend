'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatInr,
  normalizeCartItems,
  formatCartStatus,
} = require('../../utils/commerce/cartLeadGdprPdf');

describe('cartLeadGdprPdf helpers', () => {
  it('formatInr uses Rs. prefix (Helvetica-safe)', () => {
    assert.equal(formatInr(1499.9), 'Rs. 1,499.90');
    assert.equal(formatInr(2000), 'Rs. 2,000');
    assert.equal(formatInr(undefined), '—');
  });

  it('formatCartStatus maps known statuses', () => {
    assert.equal(formatCartStatus('purchased'), 'Purchased');
    assert.equal(formatCartStatus('abandoned'), 'Abandoned');
  });

  it('normalizeCartItems computes line totals', () => {
    const items = normalizeCartItems({
      cartValue: 1499.9,
      cartSnapshot: {
        items: [{ title: 'Snowboard', quantity: 2, price: 749.95 }],
      },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Snowboard');
    assert.equal(items[0].quantity, 2);
    assert.ok(Math.abs(items[0].lineTotal - 1499.9) < 0.01);
  });
});
