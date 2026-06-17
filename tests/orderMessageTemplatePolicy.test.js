'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterTemplatesForOrderMessagesList,
  filterTemplatesForOrderRule,
  isWizardProductTemplate,
} = require('../utils/meta/orderMessageTemplatePolicy');

test('filters prod_ templates from order messages list', () => {
  const list = [
    { name: 'prod_delitech_smart_wireless_video_door_phone', category: 'MARKETING', status: 'PENDING' },
    { name: 'order_delivered_update', category: 'UTILITY', status: 'DRAFT' },
    { name: 'eco_order_confirmed', category: 'UTILITY', status: 'APPROVED' },
    { name: 'cart_recovery_1', category: 'MARKETING', status: 'APPROVED' },
  ];
  const out = filterTemplatesForOrderMessagesList(list);
  const names = out.map((t) => t.name).sort();
  assert.deepEqual(names, ['eco_order_confirmed', 'order_delivered_update']);
});

test('per-rule allowlist for delivered rule', () => {
  const list = [
    { name: 'order_delivered_update', status: 'DRAFT' },
    { name: 'eco_delivered', status: 'DRAFT' },
    { name: 'order_confirmed', status: 'APPROVED' },
    { name: 'prod_wireless_chime', templateKind: 'product', status: 'PENDING' },
  ];
  const out = filterTemplatesForOrderRule('sys_shipment_delivered', list);
  assert.deepEqual(out.map((t) => t.name).sort(), ['eco_delivered', 'order_delivered_update']);
});

test('isWizardProductTemplate detects prod prefix', () => {
  assert.equal(isWizardProductTemplate({ name: 'prod_foo' }), true);
  assert.equal(isWizardProductTemplate({ name: 'eco_order_confirmed' }), false);
});
