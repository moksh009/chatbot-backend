'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSimulatorWarrantyPreview } = require('../../utils/commerce/warrantyFlowLookup');

test('buildSimulatorWarrantyPreview returns details for single order', () => {
  const profile = {
    displayPhone: '+91 9724891399',
    ordersWithWarranty: [
      {
        orderDisplay: '#1006',
        items: [
          { productName: 'Smart Doorbell', status: 'Active', duration: '1 Year' },
        ],
      },
    ],
  };
  const text = buildSimulatorWarrantyPreview(profile, 'single_order_single_item');
  assert.match(text, /#1006/);
  assert.match(text, /Smart Doorbell/);
  assert.match(text, /Menu/);
});
