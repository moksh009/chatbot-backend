'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileSegmentQuery, leadMatchesAudienceSegment } = require('../../services/segmentMembership');
const { evaluateRuleOnRow } = require('../../services/segmentAudienceEvaluation');

test('compileSegmentQuery prefers stored query when present', () => {
  const q = { leadScore: { $gte: 500 } };
  const compiled = compileSegmentQuery({ query: q, conditions: [] });
  assert.deepEqual(compiled, q);
});

test('compileSegmentQuery builds from conditionTree when query empty', () => {
  const compiled = compileSegmentQuery({
    conditionTree: {
      type: 'group',
      operator: 'AND',
      children: [{ type: 'rule', assetId: 'LEAD_SCORE', operator: '>=', targetValue: 500 }],
    },
  });
  assert.deepEqual(compiled, { leadScore: { $gte: 500 } });
});

test('leadMatchesAudienceSegment is async unified evaluator export', () => {
  assert.equal(typeof leadMatchesAudienceSegment, 'function');
  assert.equal(leadMatchesAudienceSegment.constructor.name, 'AsyncFunction');
});

test('unified rule evaluation matches lead score segment criteria', () => {
  const lead = { leadScore: 900, phoneNumber: '919999999999' };
  const match = evaluateRuleOnRow(lead, { assetId: 'LEAD_SCORE', operator: '>=', targetValue: 500 });
  assert.equal(match, true);
  const miss = evaluateRuleOnRow({ leadScore: 100, phoneNumber: '919999999999' }, {
    assetId: 'LEAD_SCORE',
    operator: '>=',
    targetValue: 500,
  });
  assert.equal(miss, false);
});
