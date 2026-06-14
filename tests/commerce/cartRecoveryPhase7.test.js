'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickAbTestTemplate, resolveAbTestTemplatesForSlot } = require('../../utils/commerce/cartRecoveryAbTest');
const { pct } = require('../../utils/commerce/recoveryFunnelMetrics');

test('pickAbTestTemplate is deterministic 50/50', () => {
  const a = pickAbTestTemplate({
    clientId: 'demo_1',
    leadId: 'lead_abc',
    stepNum: 1,
    templateA: 'cart_recovery_1',
    templateB: 'cart_recovery_1_alt',
    abTestEnabled: true,
  });
  const b = pickAbTestTemplate({
    clientId: 'demo_1',
    leadId: 'lead_abc',
    stepNum: 1,
    templateA: 'cart_recovery_1',
    templateB: 'cart_recovery_1_alt',
    abTestEnabled: true,
  });
  assert.equal(a.templateName, b.templateName);
  assert(['A', 'B'].includes(a.variant));
});

test('pickAbTestTemplate returns primary when ab test disabled', () => {
  const out = pickAbTestTemplate({
    clientId: 'demo_1',
    leadId: 'lead_abc',
    stepNum: 2,
    templateA: 'cart_recovery_2',
    templateB: 'cart_recovery_2_b',
    abTestEnabled: false,
  });
  assert.equal(out.templateName, 'cart_recovery_2');
  assert.equal(out.variant, 'A');
});

test('resolveAbTestTemplatesForSlot reads rule variant', () => {
  const out = resolveAbTestTemplatesForSlot(
    {
      isActive: true,
      templateName: 'cart_recovery_3',
      abTestTemplateName: 'cart_recovery_3_variant',
    },
    'cart_recovery_3'
  );
  assert.equal(out.primary, 'cart_recovery_3');
  assert.equal(out.variantB, 'cart_recovery_3_variant');
});

test('pct helper', () => {
  assert.equal(pct(5, 20), 25);
  assert.equal(pct(0, 0), 0);
});
