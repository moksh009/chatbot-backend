'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateTextRule,
  evaluateRuleOnRow,
  evaluateTreeOnRow,
} = require('../../services/segmentAudienceEvaluation');

test('evaluateTextRule — contains is case-insensitive', () => {
  assert.equal(evaluateTextRule('Moksh Patel', 'contains', 'moksh'), true);
  assert.equal(evaluateTextRule('Moksh Patel', 'contains', 'xyz'), false);
});

test('evaluateTextRule — is_set / is_not_set', () => {
  assert.equal(evaluateTextRule('hello', 'is_set', ''), true);
  assert.equal(evaluateTextRule('', 'is_set', ''), false);
  assert.equal(evaluateTextRule('', 'is_not_set', ''), true);
});

test('evaluateRuleOnRow — name contains', () => {
  const row = { name: 'Moksh Patel', phoneNumber: '+919876543210' };
  const match = evaluateRuleOnRow(row, {
    assetId: 'NAME',
    textOperator: 'contains',
    targetValue: 'Moksh',
  });
  assert.equal(match, true);
});

test('evaluateRuleOnRow — unknown asset fails closed', () => {
  const row = { name: 'Test', phoneNumber: '+919876543210' };
  const match = evaluateRuleOnRow(row, { assetId: 'RTO_COUNT', operator: '>=', targetValue: 1 });
  assert.equal(match, false);
});

test('evaluateTreeOnRow — AND group requires all rules', async () => {
  const row = { name: 'Moksh', ordersCount: 2, phoneNumber: '+919876543210' };
  const tree = {
    type: 'group',
    operator: 'AND',
    children: [
      { type: 'rule', assetId: 'NAME', textOperator: 'contains', targetValue: 'Moksh' },
      { type: 'rule', assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 1 },
    ],
  };
  assert.equal(await evaluateTreeOnRow(row, tree, { clientId: 'c1', memberCache: new Map() }), true);
});
