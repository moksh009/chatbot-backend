'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateWebhookSecret,
  CART_TEMPLATE_KEYS,
  resolveTemplateStatus,
  buildChecklist,
  countActiveCartRules,
  buildThirdPartyBlock,
} = require('../../utils/commerce/abandonedCartReadiness');
const { mongoCartRecoveryFilter } = require('../../utils/commerce/marketingConsent');
const { mergeSystemAutomations } = require('../../utils/commerce/commerceAutomationPresets');
const { planCartRuleActivation } = require('../../constants/cartRecoverySlotPresets');

test('generateWebhookSecret returns hex string', () => {
  const s = generateWebhookSecret();
  assert.equal(typeof s, 'string');
  assert.ok(s.length >= 32);
});

test('mongoCartRecoveryFilter excludes opted_out leads by default', () => {
  const filter = mongoCartRecoveryFilter({});
  assert.deepEqual(filter, { optStatus: { $ne: 'opted_out' } });
});

test('mongoCartRecoveryFilter strict mode requires opted_in', () => {
  const filter = mongoCartRecoveryFilter({ growthCompliance: { cartRecoveryRequiresOptIn: true } });
  assert.deepEqual(filter, { optStatus: 'opted_in' });
});

test('cron cart query merges opt-out filter (simulated AdLead query shape)', () => {
  const client = { clientId: 'c1', growthCompliance: {} };
  const query = {
    clientId: client.clientId,
    ...mongoCartRecoveryFilter(client),
    cartStatus: 'abandoned',
  };
  assert.equal(query.optStatus.$ne, 'opted_out');
  assert.equal(query.clientId, 'c1');
});

test('CART_TEMPLATE_KEYS lists three recovery templates', () => {
  assert.deepEqual(CART_TEMPLATE_KEYS, [
    'cart_recovery_1',
    'cart_recovery_2',
    'cart_recovery_3',
  ]);
});

test('resolveTemplateStatus maps synced + meta rows', () => {
  const synced = [{ name: 'cart_recovery_1', status: 'APPROVED' }];
  const metaRows = [{ name: 'cart_recovery_2', status: 'pending_meta_review' }];
  assert.equal(resolveTemplateStatus('cart_recovery_1', synced, metaRows), 'approved');
  assert.equal(resolveTemplateStatus('cart_recovery_2', synced, metaRows), 'pending');
  assert.equal(resolveTemplateStatus('cart_recovery_3', synced, metaRows), 'missing');
});

test('countActiveCartRules counts live abandoned_cart automations', () => {
  const rules = mergeSystemAutomations([
    { id: 'sys_cart_followup_1', isActive: true, templateName: 'cart_recovery_1', meta: { category: 'abandoned_cart' } },
    { id: 'sys_cart_followup_2', isActive: false, templateName: 'cart_recovery_2', meta: { category: 'abandoned_cart' } },
  ]);
  assert.equal(countActiveCartRules(rules), 1);
});

test('buildChecklist marks recovery on when templates + rules satisfied', () => {
  const items = buildChecklist({
    flags: { shopify_connected: true, whatsapp_connected: true },
    wf: { enableAbandonedCart: true },
    cartRulesActive: 3,
    templates: { cart_recovery_1: 'approved', cart_recovery_2: 'approved', cart_recovery_3: 'approved' },
    approvedCount: 3,
    pixelInstalled: true,
    lastEventAt: new Date().toISOString(),
    unknownPhonePct: 10,
    recoveryOn: true,
  });
  const byId = Object.fromEntries(items.map((i) => [i.id, i.status]));
  assert.equal(byId.shopify, 'ok');
  assert.equal(byId.templates, 'ok');
  assert.equal(byId.rules, 'ok');
  assert.equal(byId.recovery, 'ok');
});

test('planCartRuleActivation gates enable recovery rule upserts', () => {
  assert.equal(planCartRuleActivation({ allTemplatesApproved: false }).count, 0);
  assert.equal(planCartRuleActivation({ allTemplatesApproved: true }).count, 3);
});

test('mergeSystemAutomations includes three cart follow-up rules', () => {
  const rules = mergeSystemAutomations([]);
  const cart = rules.filter((r) => r.meta?.category === 'abandoned_cart');
  assert.equal(cart.length, 3);
});

test('buildThirdPartyBlock exposes webhook URLs per provider', () => {
  const rows = buildThirdPartyBlock('client_abc', {
    integrations: { gokwik: { webhookSecret: 'secret123' } },
  });
  assert.equal(rows.length, 3);
  const gokwik = rows.find((r) => r.id === 'gokwik');
  assert.match(gokwik.webhookUrl, /\/api\/webhooks\/gokwik\/client_abc$/);
  assert.equal(gokwik.configured, true);
  assert.ok(gokwik.secretMasked.includes('••••'));
});
