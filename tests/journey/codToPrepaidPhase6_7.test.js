'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CONVERTED_TAG_RE,
  extractConvertedCodOrderId,
} = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidWebhookHandler');
const {
  ORDER_CANCEL_MUTATION,
} = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidShopify');
const {
  evaluateCodPrepaidOutcomeCondition,
} = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidJourneyAdvance');
const { codPrepaidOutcomeCondition } = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidBranchGates');

describe('Part 6 — conversion tag detection', () => {
  it('matches Converted_From_COD_<numericId> tag pattern', () => {
    assert.equal(CONVERTED_TAG_RE.test('Converted_From_COD_6100987234567'), true);
    assert.equal(CONVERTED_TAG_RE.test('Converted_From_COD_'), false);
    assert.equal(CONVERTED_TAG_RE.test('other_tag'), false);
  });

  it('extracts numeric COD order id from array or comma-separated tags', () => {
    assert.equal(
      extractConvertedCodOrderId(['foo', 'Converted_From_COD_6100987234567']),
      '6100987234567'
    );
    assert.equal(
      extractConvertedCodOrderId('foo, Converted_From_COD_99, bar'),
      '99'
    );
    assert.equal(extractConvertedCodOrderId(['no_match']), '');
  });
});

describe('Part 6 — orderCancel mutation (exact spec)', () => {
  it('uses required GraphQL fields and variables', () => {
    assert.match(ORDER_CANCEL_MUTATION, /mutation orderCancel\(\$orderId: ID!/);
    assert.match(ORDER_CANCEL_MUTATION, /restock: Boolean!/);
    assert.match(ORDER_CANCEL_MUTATION, /reason: OrderCancelReason!/);
    assert.match(ORDER_CANCEL_MUTATION, /notifyCustomer/);
    assert.match(ORDER_CANCEL_MUTATION, /staffNote/);
  });
});

describe('Part 7 — output branch conditions', () => {
  it('builds message_sent, failed, and converted branch gates', () => {
    assert.equal(
      codPrepaidOutcomeCondition('message_sent', 'cod_1'),
      'cod_prepaid_outcome:message_sent:cod_1'
    );
    assert.equal(
      codPrepaidOutcomeCondition('failed', 'cod_1'),
      'cod_prepaid_outcome:failed:cod_1'
    );
    assert.equal(
      codPrepaidOutcomeCondition('converted', 'cod_1'),
      'cod_prepaid_outcome:converted:cod_1'
    );
  });

  it('routes message_sent branch after sync success outcome', () => {
    const result = evaluateCodPrepaidOutcomeCondition(
      { sequenceContext: { codPrepaidOutcomes: { cod_1: 'message_sent' } } },
      'cod_prepaid_outcome:message_sent:cod_1'
    );
    assert.equal(result.proceed, true);
  });

  it('routes failed branch after sync failure outcome', () => {
    const result = evaluateCodPrepaidOutcomeCondition(
      { sequenceContext: { codPrepaidOutcomes: { cod_1: 'failed' } } },
      'cod_prepaid_outcome:failed:cod_1'
    );
    assert.equal(result.proceed, true);
  });

  it('defers converted branch until async webhook sets converted outcome', () => {
    const afterMessageSent = evaluateCodPrepaidOutcomeCondition(
      { sequenceContext: { codPrepaidOutcomes: { cod_1: 'message_sent' } } },
      'cod_prepaid_outcome:converted:cod_1'
    );
    assert.equal(afterMessageSent.proceed, false);
    assert.equal(afterMessageSent.reason, 'cod_prepaid_outcome_pending');
    assert.equal(afterMessageSent.defer, true);

    const afterConverted = evaluateCodPrepaidOutcomeCondition(
      { sequenceContext: { codPrepaidOutcomes: { cod_1: 'converted' } } },
      'cod_prepaid_outcome:converted:cod_1'
    );
    assert.equal(afterConverted.proceed, true);
  });

  it('skips non-matching sync branches (message_sent blocks failed path)', () => {
    const result = evaluateCodPrepaidOutcomeCondition(
      { sequenceContext: { codPrepaidOutcomes: { cod_1: 'message_sent' } } },
      'cod_prepaid_outcome:failed:cod_1'
    );
    assert.equal(result.proceed, false);
    assert.match(result.reason, /mismatch/);
  });
});
