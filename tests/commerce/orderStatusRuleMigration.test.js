'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeSystemAutomations,
  applyRetiredRuleMigrations,
  buildSystemAutomations,
} = require('../../utils/commerce/commerceAutomationPresets');
const { syncSystemOrderRulesFromNicheMap } = require('../../utils/commerce/commerceAutomationService');

test('mergeSystemAutomations exposes exactly seven order-status rules (6 delivery + COD)', () => {
  const merged = mergeSystemAutomations([]);
  const orderRules = merged.filter((r) => r.meta?.category === 'order_notification');
  assert.equal(orderRules.length, 7);
  assert.deepEqual(
    orderRules.map((r) => r.id),
    [
      'sys_fulfillment_unfulfilled',
      'sys_shipment_in_transit',
      'sys_shipment_out_for_delivery',
      'sys_shipment_delivered',
      'sys_shipment_attempted_delivery',
      'sys_shipment_failure',
      'sys_commerce_cod_confirm',
    ]
  );
});

test('applyRetiredRuleMigrations copies sys_financial_paid → Order placed', () => {
  const existing = [
    {
      id: 'sys_financial_paid',
      templateName: 'eco_order_confirmed',
      isActive: true,
      variableMappings: { body: { 1: 'first_name', 2: 'order_id' } },
      channels: ['whatsapp', 'email'],
      emailConfig: { templateId: 'order_confirmed', sendWhen: 'always' },
      meta: { category: 'order_notification' },
    },
    ...buildSystemAutomations().filter((r) => r.id === 'sys_fulfillment_unfulfilled'),
  ];

  const migrated = applyRetiredRuleMigrations(existing);
  const placed = migrated.find((r) => r.id === 'sys_fulfillment_unfulfilled');
  assert.equal(placed.templateName, 'eco_order_confirmed');
  assert.equal(placed.isActive, true);
  assert.equal(placed.variableMappings.body['1'], 'first_name');
  assert.deepEqual(placed.channels, ['whatsapp', 'email']);
  assert.equal(placed.emailConfig.templateId, 'order_confirmed');

  const merged = mergeSystemAutomations(existing);
  const placedMerged = merged.find((r) => r.id === 'sys_fulfillment_unfulfilled');
  assert.equal(placedMerged.templateName, 'eco_order_confirmed');
  assert.equal(placedMerged.isActive, true);
  assert.ok(!merged.some((r) => r.id === 'sys_financial_paid'));
});

test('applyRetiredRuleMigrations copies fulfilled → in transit when empty', () => {
  const existing = [
    {
      id: 'sys_fulfillment_fulfilled',
      templateName: 'eco_shipping_update',
      isActive: true,
      meta: { category: 'order_notification' },
    },
    ...buildSystemAutomations(),
  ];

  const merged = mergeSystemAutomations(existing);
  const inTransit = merged.find((r) => r.id === 'sys_shipment_in_transit');
  assert.equal(inTransit.templateName, 'eco_shipping_update');
  assert.equal(inTransit.isActive, true);
  assert.ok(!merged.some((r) => r.id === 'sys_fulfillment_fulfilled'));
});

test('pending migration skipped when paid already migrated', () => {
  const existing = [
    {
      id: 'sys_financial_paid',
      templateName: 'eco_order_confirmed',
      isActive: true,
      meta: { category: 'order_notification' },
    },
    {
      id: 'sys_financial_pending',
      templateName: 'order_confirmation_v1',
      isActive: true,
      meta: { category: 'order_notification' },
    },
    ...buildSystemAutomations(),
  ];

  const merged = mergeSystemAutomations(existing);
  const placed = merged.find((r) => r.id === 'sys_fulfillment_unfulfilled');
  assert.equal(placed.templateName, 'eco_order_confirmed');
});

test('syncSystemOrderRulesFromNicheMap maps legacy paid/shipped keys', () => {
  const automations = mergeSystemAutomations([]);
  const nicheData = {
    orderStatusTemplates: {
      paid: 'eco_order_confirmed',
      shipped: 'eco_shipping_update',
    },
  };
  const synced = syncSystemOrderRulesFromNicheMap(automations, nicheData);
  const placed = synced.find((r) => r.id === 'sys_fulfillment_unfulfilled');
  const inTransit = synced.find((r) => r.id === 'sys_shipment_in_transit');
  assert.equal(placed.templateName, 'eco_order_confirmed');
  assert.equal(placed.isActive, true);
  assert.equal(inTransit.templateName, 'eco_shipping_update');
  assert.equal(inTransit.isActive, true);
});
