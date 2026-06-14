'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  autoLinkApprovedTemplatesToSystemRules,
  cartFollowupSlotFromRule,
} = require('../../utils/commerce/commerceAutomationService');

test('cartFollowupSlotFromRule parses sys_cart_followup_* ids', () => {
  assert.equal(
    cartFollowupSlotFromRule({ id: 'sys_cart_followup_2', meta: { category: 'abandoned_cart' } }),
    'followup_2'
  );
});

test('autoLinkApprovedTemplatesToSystemRules links approved templates and activates empty rules', () => {
  const synced = [
    { name: 'cart_recovery_1', status: 'APPROVED' },
    { name: 'cart_recovery_2', status: 'APPROVED' },
  ];
  const rules = [
    {
      id: 'sys_cart_followup_1',
      isActive: false,
      templateName: '',
      meta: { category: 'abandoned_cart', systemSlot: 'followup_1' },
    },
    {
      id: 'sys_cart_followup_2',
      isActive: false,
      templateName: 'old_name',
      meta: { category: 'abandoned_cart', systemSlot: 'followup_2' },
    },
    {
      id: 'sys_cart_followup_3',
      isActive: false,
      templateName: '',
      meta: { category: 'abandoned_cart', systemSlot: 'followup_3' },
    },
  ];

  const linked = autoLinkApprovedTemplatesToSystemRules(rules, synced);
  const r1 = linked.find((r) => r.id === 'sys_cart_followup_1');
  const r2 = linked.find((r) => r.id === 'sys_cart_followup_2');
  const r3 = linked.find((r) => r.id === 'sys_cart_followup_3');

  assert.equal(r1.templateName, 'cart_recovery_1');
  assert.equal(r1.isActive, true);
  assert.equal(r2.templateName, 'cart_recovery_2');
  assert.equal(r2.isActive, false);
  assert.equal(r3.templateName, '');
  assert.equal(r3.isActive, false);
});

test('autoLinkApprovedTemplatesToSystemRules does not override merchant-paused rules with templates', () => {
  const synced = [{ name: 'cart_recovery_1', status: 'APPROVED' }];
  const rules = [
    {
      id: 'sys_cart_followup_1',
      isActive: false,
      templateName: 'cart_recovery_1',
      meta: { category: 'abandoned_cart', systemSlot: 'followup_1' },
    },
  ];
  const linked = autoLinkApprovedTemplatesToSystemRules(rules, synced);
  assert.equal(linked[0].isActive, false);
});
