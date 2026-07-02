'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { filterTemplatesForCodPrepaidPicker } = require('../../utils/meta/codPrepaidTemplatePolicy');
const {
  resolveCodPrepaidDiscountLabel,
  buildCodPrepaidAppliedDiscount,
} = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidDiscount');
const { buildDraftOrderInput } = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidExecutor');

describe('codPrepaid template picker policy', () => {
  const templates = [
    { name: 'm1', status: 'APPROVED', category: 'MARKETING' },
    { name: 'u1', status: 'APPROVED', category: 'UTILITY' },
    { name: 'a1', status: 'APPROVED', category: 'AUTHENTICATION' },
    { name: 'm_pending', status: 'PENDING', category: 'MARKETING' },
    { name: 'hello_world', status: 'APPROVED', category: 'MARKETING' },
  ];

  it('returns approved MARKETING and UTILITY templates only', () => {
    const result = filterTemplatesForCodPrepaidPicker(templates);
    assert.deepEqual(result.map((t) => t.name), ['m1', 'u1']);
  });
});

describe('codPrepaid discount label', () => {
  it('falls back to Prepaid Discount when empty', () => {
    assert.equal(resolveCodPrepaidDiscountLabel(''), 'Prepaid Discount');
    assert.equal(resolveCodPrepaidDiscountLabel('   '), 'Prepaid Discount');
    assert.equal(resolveCodPrepaidDiscountLabel(null), 'Prepaid Discount');
  });

  it('trims custom merchant label', () => {
    assert.equal(resolveCodPrepaidDiscountLabel('  COD Saver  '), 'COD Saver');
  });

  it('maps appliedDiscount description for Shopify draft order', () => {
    const discount = buildCodPrepaidAppliedDiscount({
      discountName: 'Flash Offer',
      discountValue: 100,
      discountValueType: 'FIXED_AMOUNT',
    });
    assert.deepEqual(discount, {
      description: 'Flash Offer',
      value: 100,
      valueType: 'FIXED_AMOUNT',
    });
  });

  it('uses fallback label in draft order input when name cleared', () => {
    const { input } = buildDraftOrderInput(
      {
        shopifyOrderNumericId: '123',
        lineItems: [{ variantGid: 'gid://shopify/ProductVariant/1', quantity: 1 }],
      },
      {
        discountName: '   ',
        discountValue: 50,
        discountValueType: 'PERCENTAGE',
      }
    );
    assert.deepEqual(input.appliedDiscount, {
      description: 'Prepaid Discount',
      value: 50,
      valueType: 'PERCENTAGE',
    });
  });
});
