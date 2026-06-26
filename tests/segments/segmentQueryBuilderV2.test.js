'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { translateTreeToQuery, translateRuleToMongo } = require('../../services/SegmentQueryBuilderV2');
const {
  flatConditionsToTree,
  resolveSegmentDefinition,
  serializeSegment,
} = require('../../utils/segmentConditionUtils');

test('flat conditions migrate to AND group tree', () => {
  const conditions = [
    { assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 1 },
    { assetId: 'LTV', operator: '>=', targetValue: 500 },
  ];
  const { conditionTree, conditions: flat } = resolveSegmentDefinition({ conditions });
  assert.equal(conditionTree.type, 'group');
  assert.equal(conditionTree.operator, 'AND');
  assert.equal(conditionTree.children.length, 2);
  assert.equal(flat.length, 2);
});

test('nested OR group compiles to $or query', () => {
  const tree = {
    type: 'group',
    operator: 'OR',
    children: [
      { type: 'rule', assetId: 'TOTAL_ORDERS', operator: '===', targetValue: 0 },
      { type: 'rule', assetId: 'TOTAL_ORDERS', operator: '===', targetValue: 1 },
    ],
  };
  const query = translateTreeToQuery(tree);
  assert.ok(query.$or);
  assert.equal(query.$or.length, 2);
  assert.deepEqual(query.$or[0], { ordersCount: { $eq: 0 } });
  assert.deepEqual(query.$or[1], { ordersCount: { $eq: 1 } });
});

test('frequency atleast_once maps to >= 1', () => {
  const clause = translateRuleToMongo({
    assetId: 'TOTAL_ORDERS',
    frequency: 'atleast_once',
    targetValue: 0,
  });
  assert.deepEqual(clause, { ordersCount: { $gte: 1 } });
});

test('frequency zero_times maps to === 0', () => {
  const clause = translateRuleToMongo({
    assetId: 'CHECKOUTS_STARTED',
    frequency: 'zero_times',
  });
  assert.deepEqual(clause, { checkoutInitiatedCount: { $eq: 0 } });
});

test('serializeSegment wraps legacy conditions only documents', () => {
  const out = serializeSegment({
    name: 'Legacy',
    conditions: [{ assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 2 }],
  });
  assert.ok(out.conditionTree);
  assert.equal(out.conditions.length, 1);
  const query = translateTreeToQuery(out.conditionTree);
  assert.deepEqual(query, { ordersCount: { $gte: 2 } });
});

test('not purchased in 90d preset uses OR with never-purchased', () => {
  const { SYSTEM_SEGMENT_PRESETS } = require('../../constants/systemSegmentPresets');
  const preset = SYSTEM_SEGMENT_PRESETS.find((p) => p.presetKey === 'not_ordered_90d');
  assert.ok(preset?.conditionTree);
  const query = translateTreeToQuery(preset.conditionTree);
  assert.ok(query.$or);
  assert.equal(query.$or.length, 2);
});

test('flatConditionsToTree produces valid compiler input', () => {
  const tree = flatConditionsToTree([{ assetId: 'HAS_TAG', operator: '===', targetValue: 'vip' }]);
  const query = translateTreeToQuery(tree);
  assert.deepEqual(query, { tags: { $in: ['vip'] } });
});

test('NAME contains compiles to case-insensitive regex', () => {
  const clause = translateRuleToMongo({
    assetId: 'NAME',
    operator: 'text',
    textOperator: 'contains',
    targetValue: 'Moksh',
  });
  assert.ok(clause.name);
  assert.ok(clause.name.$regex);
});

test('segment_membership rule compiles to empty (unified eval only)', () => {
  const query = translateTreeToQuery({
    type: 'rule',
    ruleKind: 'segment_membership',
    segmentId: '507f1f77bcf86cd799439011',
    membershipOperator: 'in',
  });
  assert.deepEqual(query, {});
});

test('not equals operator compiles to $ne', () => {
  const clause = translateRuleToMongo({
    assetId: 'OPT_STATUS',
    operator: '!==',
    targetValue: 'opted_out',
  });
  assert.deepEqual(clause, { optStatus: { $ne: 'opted_out' } });
});

test('AD_CHANNEL contains compiles to nested regex', () => {
  const clause = translateRuleToMongo({
    assetId: 'AD_CHANNEL',
    textOperator: 'contains',
    targetValue: 'meta',
  });
  assert.ok(clause['adAttribution.source']);
  assert.ok(clause['adAttribution.source'].$regex);
});
