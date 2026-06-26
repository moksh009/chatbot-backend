'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateRuleOnRow,
  evaluateTreeOnRow,
  evaluateTextRule,
} = require('../../services/segmentAudienceEvaluation');
const { resolveSegmentDefinition, resolveSegmentDefinitionForPreview, validateRuleNode } = require('../../utils/segmentConditionUtils');
const { buildSegmentCatalog, isEntryEligible } = require('../../services/segmentCatalogService');
const { PROPERTIES, BEHAVIORS } = require('../../constants/segmentRuleCatalog');

const baseRow = {
  name: 'Moksh Patel',
  email: 'moksh@example.com',
  phoneNumber: '+919876543210',
  ordersCount: 3,
  totalSpent: 7500,
  cartStatus: 'abandoned',
  cartValue: 1200,
  leadScore: 82,
  optStatus: 'opted_in',
  source: 'whatsapp',
  tags: ['vip', 'repeat'],
  inboundMessageCount: 12,
  checkoutInitiatedCount: 2,
  addToCartCount: 5,
  adAttribution: { source: 'meta_ads' },
  channelConsent: { email: { status: 'opted_in' } },
  lastPurchaseDate: new Date(Date.now() - 20 * 86400000).toISOString(),
  lastInteraction: new Date(Date.now() - 2 * 86400000).toISOString(),
};

test('empty rule group matches nobody (fail closed)', async () => {
  const tree = { type: 'group', operator: 'AND', children: [] };
  assert.equal(await evaluateTreeOnRow(baseRow, tree, { clientId: 'c1', memberCache: new Map() }), false);
});

test('property rules — commerce numbers', () => {
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 2 }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'LTV', operator: '>=', targetValue: 5000 }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'LTV', operator: 'between', targetValue: 1000, targetValueEnd: 8000 }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'CART_VALUE', operator: '>=', targetValue: 1000 }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'AOV', operator: '>=', targetValue: 2000 }), true);
});

test('property rules — identity text', () => {
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'NAME', textOperator: 'contains', targetValue: 'moksh' }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'EMAIL', textOperator: 'contains', targetValue: '@example' }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'PHONE', textOperator: 'is_set', targetValue: '' }), true);
  assert.equal(evaluateRuleOnRow({ ...baseRow, phoneNumber: '' }, { assetId: 'PHONE', textOperator: 'is_not_set', targetValue: '' }), true);
});

test('property rules — enum and boolean', () => {
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'CART_STATUS', operator: '===', targetValue: 'abandoned' }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'OPT_STATUS', operator: '===', targetValue: 'opted_in' }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'EMAIL_CONSENT', operator: '===', targetValue: 'opted_in' }), true);
  assert.equal(
    evaluateRuleOnRow({ ordersCount: 0, inboundMessageCount: 1 }, { assetId: 'JUST_LANDED', operator: '===', targetValue: true }),
    true
  );
});

test('property rules — tags and attribution', () => {
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'HAS_TAG', textOperator: 'equals', targetValue: 'vip' }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'HAS_TAG', textOperator: 'contains', targetValue: 're' }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'LEAD_SOURCE', textOperator: 'equals', targetValue: 'whatsapp' }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'AD_CHANNEL', textOperator: 'contains', targetValue: 'meta' }), true);
});

test('property rules — calculated days', () => {
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'DAYS_SINCE_LAST_PURCHASE', operator: '<=', targetValue: 30 }), true);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'DAYS_SINCE_LAST_SEEN', operator: '<=', targetValue: 7 }), true);
});

test('behavior rules — frequency mapping', () => {
  assert.equal(
    evaluateRuleOnRow(baseRow, {
      ruleKind: 'behavior',
      behaviorId: 'BEHAVIOR_ORDER_PLACED',
      assetId: 'TOTAL_ORDERS',
      frequency: 'atleast_once',
      targetValue: 1,
    }),
    true
  );
  assert.equal(
    evaluateRuleOnRow(baseRow, {
      ruleKind: 'behavior',
      behaviorId: 'BEHAVIOR_CART_ABANDONED',
      assetId: 'CART_STATUS',
      operator: '===',
      targetValue: 'abandoned',
    }),
    true
  );
  assert.equal(
    evaluateRuleOnRow(baseRow, {
      ruleKind: 'behavior',
      behaviorId: 'BEHAVIOR_WA_MESSAGE',
      assetId: 'TOTAL_INTERACTIONS',
      frequency: 'atleast_x',
      targetValue: 10,
    }),
    true
  );
});

test('frequency operators on property', () => {
  assert.equal(
    evaluateRuleOnRow(baseRow, { assetId: 'TOTAL_ORDERS', frequency: 'atleast_once', targetValue: 0 }),
    true
  );
  assert.equal(
    evaluateRuleOnRow({ ...baseRow, ordersCount: 0 }, { assetId: 'TOTAL_ORDERS', frequency: 'zero_times' }),
    true
  );
  assert.equal(
    evaluateRuleOnRow(baseRow, { assetId: 'TOTAL_ORDERS', frequency: 'exactly_x', targetValue: 3 }),
    true
  );
});

test('dead assets fail closed', () => {
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'RTO_COUNT', operator: '>=', targetValue: 0 }), false);
  assert.equal(evaluateRuleOnRow(baseRow, { assetId: 'EXCHANGE_REFUND_COUNT', operator: '>=', targetValue: 0 }), false);
});

test('resolveSegmentDefinition validates membership and text rules', () => {
  const membership = resolveSegmentDefinition({
    conditionTree: {
      type: 'group',
      operator: 'AND',
      children: [
        {
          type: 'rule',
          ruleKind: 'segment_membership',
          segmentId: '507f1f77bcf86cd799439011',
          membershipOperator: 'not_in',
        },
      ],
    },
  });
  assert.equal(membership.conditions[0].ruleKind, 'segment_membership');

  const textRule = resolveSegmentDefinition({
    conditionTree: {
      type: 'group',
      operator: 'AND',
      children: [
        {
          type: 'rule',
          ruleKind: 'property',
          assetId: 'NAME',
          textOperator: 'contains',
          targetValue: 'Moksh',
        },
      ],
    },
  });
  assert.equal(textRule.conditions[0].textOperator, 'contains');

  assert.throws(() => validateRuleNode({ ruleKind: 'segment_membership', segmentId: '' }));
  assert.throws(() => validateRuleNode({ assetId: 'NAME', textOperator: 'contains', targetValue: '' }));
});

test('catalog hides dead assets and gates by connection', () => {
  const disconnected = { shopify_connected: false, whatsapp_connected: false, email_connected: false };
  const connected = { shopify_connected: true, whatsapp_connected: true, email_connected: true };

  const shopifyOnly = PROPERTIES.find((p) => p.id === 'LTV');
  const waOnly = PROPERTIES.find((p) => p.id === 'OPT_STATUS');
  const dead = PROPERTIES.find((p) => p.id === 'RTO_COUNT');

  assert.equal(isEntryEligible(shopifyOnly, disconnected), false);
  assert.equal(isEntryEligible(shopifyOnly, connected), true);
  assert.equal(isEntryEligible(waOnly, { ...connected, whatsapp_connected: false }), false);
  assert.equal(dead, undefined);

  const behaviorIds = BEHAVIORS.map((b) => b.id);
  assert.ok(behaviorIds.includes('BEHAVIOR_ORDER_PLACED'));
  assert.ok(behaviorIds.includes('BEHAVIOR_WA_MESSAGE'));
});

test('evaluateTextRule phone suffix', () => {
  assert.equal(evaluateTextRule('+919876543210', 'contains', '98765'), true);
  assert.equal(evaluateTextRule('', 'is_not_set', ''), true);
});

test('preview mode keeps complete rules and skips incomplete drafts', () => {
  const tree = {
    type: 'group',
    operator: 'AND',
    children: [
      {
        type: 'rule',
        ruleKind: 'segment_membership',
        membershipOperator: 'not_in',
        segmentId: '507f1f77bcf86cd799439011',
      },
      {
        type: 'rule',
        ruleKind: 'property',
        assetId: 'NAME',
        textOperator: 'contains',
        targetValue: '',
        operator: 'text',
      },
    ],
  };
  const preview = resolveSegmentDefinitionForPreview({ conditionTree: tree });
  assert.equal(preview.conditions.length, 1);
  assert.equal(preview.conditions[0].ruleKind, 'segment_membership');
  assert.throws(() => resolveSegmentDefinition({ conditionTree: tree }));
});

test('group without children array normalizes to empty group', () => {
  const out = resolveSegmentDefinitionForPreview({
    conditionTree: { type: 'group', operator: 'AND' },
  });
  assert.equal(out.conditions.length, 0);
  assert.equal(out.conditionTree.children.length, 0);
});
