/**
 * Phase 3 smoke — order email merge + rule matching (no Mongo).
 */
const assert = require('assert');
const {
  buildOrderEmailContext,
  applyMergeContext,
  ruleHasEmailConfig,
  normalizeRuleChannels,
  resolveOrderEmailTemplate,
} = require('../utils/core/orderEmailMergeFields');
const { ruleMatchesStatus } = require('../utils/commerce/orderStatusAutomationHandler');
const { defaultEmailConfigForRule } = require('../constants/prebuiltOrderEmailTemplates');

function testOrderContextMerge() {
  const ctx = buildOrderEmailContext(
    {
      id: '12345',
      name: '#1001',
      total_price: '1499.00',
      currency: 'INR',
      financial_status: 'paid',
      customer: { first_name: 'Aarav', email: 'aarav@example.com' },
      line_items: [{ title: 'Hoodie', quantity: 1, price: '1499.00' }],
    },
    null,
    { name: 'Demo Store', shopDomain: 'demo.myshopify.com' }
  );
  assert.strictEqual(ctx.first_name, 'Aarav');
  assert.ok(ctx.order_number.includes('1001'));
  assert.ok(ctx.order_total.includes('1,499') || ctx.order_total.includes('1499'));
  const merged = applyMergeContext('Hi {{first_name}}, order {{order_number}}', '<p>{{line_items_html}}</p>', ctx);
  assert.ok(merged.subject.includes('Aarav'));
  assert.ok(merged.html.includes('Hoodie'));
}

function testRuleEmailConfigDefaults() {
  const ec = defaultEmailConfigForRule('sys_financial_paid');
  assert.strictEqual(ec.templateId, 'order_confirmed');
  const rule = { id: 'sys_financial_paid', emailConfig: ec };
  assert.strictEqual(ruleHasEmailConfig(rule), true);
}

function testDualChannelRuleMatch() {
  const waRule = {
    isActive: true,
    triggerStatusType: 'financial',
    triggerStatus: 'paid',
    templateName: 'order_confirmation_v1',
    channels: ['whatsapp'],
    emailConfig: defaultEmailConfigForRule('sys_financial_paid'),
  };
  assert.strictEqual(ruleMatchesStatus(waRule, 'financial', 'paid'), true);

  const emailOnly = {
    isActive: true,
    triggerStatusType: 'financial',
    triggerStatus: 'paid',
    templateName: '',
    channels: ['email'],
    emailConfig: defaultEmailConfigForRule('sys_financial_paid'),
  };
  assert.strictEqual(ruleMatchesStatus(emailOnly, 'financial', 'paid'), true);
}

async function testResolvePrebuiltTemplate() {
  const tpl = await resolveOrderEmailTemplate({
    rule: {
      id: 'sys_financial_paid',
      emailConfig: defaultEmailConfigForRule('sys_financial_paid'),
    },
    clientId: 'demo',
    context: {
      first_name: 'Priya',
      order_number: '#2002',
      order_total: '₹999',
      line_items_html: '<p>Item</p>',
      store_name: 'Brand',
    },
  });
  assert.strictEqual(tpl.ok, true);
  assert.ok(tpl.subject.includes('confirmed'));
  assert.ok(tpl.html.includes('Priya'));
}

function testNormalizeChannels() {
  assert.deepStrictEqual(normalizeRuleChannels({ channels: ['email', 'whatsapp', 'sms'] }), [
    'email',
    'whatsapp',
  ]);
}

let failed = 0;
const tests = [
  ['orderContextMerge', testOrderContextMerge],
  ['ruleEmailConfigDefaults', testRuleEmailConfigDefaults],
  ['dualChannelRuleMatch', testDualChannelRuleMatch],
  ['normalizeChannels', testNormalizeChannels],
  ['resolvePrebuiltTemplate', testResolvePrebuiltTemplate],
];

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`✗ ${name}:`, e.message);
    }
  }
  process.exit(failed ? 1 : 0);
})();
