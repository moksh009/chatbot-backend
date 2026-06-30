'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateSequenceStepCondition,
  evaluatePositiveCondition,
} = require('../../utils/messaging/evaluateSequenceStepCondition');

describe('evaluateSequenceStepCondition negated gates', () => {
  it('inverts positive result for not_* prefix', async () => {
    const positive = await evaluatePositiveCondition({
      clientId: 'c1',
      phone: '919999999999',
      condition: '',
      sequence: {},
    });
    assert.equal(positive.proceed, true);

    const negated = await evaluateSequenceStepCondition({
      clientId: 'c1',
      phone: '919999999999',
      step: { condition: 'not_prepaid_order' },
      sequence: { sourceOrderId: '', steps: [] },
    });
    assert.equal(negated.proceed, false);
  });

  it('empty condition always proceeds', async () => {
    const result = await evaluateSequenceStepCondition({
      clientId: 'c1',
      phone: '919999999999',
      step: { condition: '' },
      sequence: {},
    });
    assert.equal(result.proceed, true);
  });

  it('not_unknown_gate inverts default proceed true to false', async () => {
    const result = await evaluateSequenceStepCondition({
      clientId: 'c1',
      phone: '919999999999',
      step: { condition: 'not_some_unknown_gate' },
      sequence: {},
    });
    assert.equal(result.proceed, false);
  });
});
