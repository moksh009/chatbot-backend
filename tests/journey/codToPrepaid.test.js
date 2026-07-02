'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { compileGraphToSteps } = require('../../services/journeyBuilder/compileGraphToSteps');
const { JOURNEY_NODE_TYPES } = require('../../services/journeyBuilder/journeyNodeContract');
const {
  codPrepaidOutcomeCondition,
  parseCodPrepaidOutcomeCondition,
} = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidBranchGates');
const {
  extractConvertedCodOrderId,
  CONVERTED_TAG_RE,
} = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidWebhookHandler');
const {
  buildDraftOrderInput,
  computeExpiresAt,
} = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidExecutor');
const { evaluateCodPrepaidOutcomeCondition } = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidJourneyAdvance');

function node(id, type, data, y) {
  return {
    id,
    type,
    position: { x: 80, y },
    data: { nodeType: type, ...data },
  };
}

function edge(id, source, target, sourceHandle) {
  return { id, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

describe('codToPrepaid branch gates', () => {
  it('builds and parses outcome conditions', () => {
    const cond = codPrepaidOutcomeCondition('message_sent', 'cod_1');
    assert.equal(cond, 'cod_prepaid_outcome:message_sent:cod_1');
    const parsed = parseCodPrepaidOutcomeCondition(cond);
    assert.deepEqual(parsed, { outcome: 'message_sent', graphNodeId: 'cod_1' });
  });
});

describe('codToPrepaid webhook tag extraction', () => {
  it('extracts numeric COD order id from Converted_From_COD tag', () => {
    assert.equal(
      extractConvertedCodOrderId(['foo', 'Converted_From_COD_6100987234567']),
      '6100987234567'
    );
    assert.equal(CONVERTED_TAG_RE.test('Converted_From_COD_123'), true);
    assert.equal(extractConvertedCodOrderId(['other_tag']), '');
  });
});

describe('codToPrepaid draft order input', () => {
  it('maps snapshot to DraftOrderInput with exact tag format', () => {
    const { input, tag } = buildDraftOrderInput({
      shopifyOrderNumericId: '6100987234567',
      shopifyOrderGid: 'gid://shopify/Order/6100987234567',
      customerGid: 'gid://shopify/Customer/99',
      lineItems: [
        {
          variantGid: 'gid://shopify/ProductVariant/111',
          quantity: 2,
        },
      ],
      shippingAddress: {
        address1: '1 Main St',
        city: 'Mumbai',
        province: 'MH',
        countryCode: 'IN',
        zip: '400001',
      },
    });
    assert.equal(tag, 'Converted_From_COD_6100987234567');
    assert.deepEqual(input.tags, ['Converted_From_COD_6100987234567']);
    assert.equal(input.customerId, 'gid://shopify/Customer/99');
    assert.equal(input.lineItems[0].variantId, 'gid://shopify/ProductVariant/111');
    assert.equal(input.lineItems[0].quantity, 2);
    assert.equal(input.shippingAddress.city, 'Mumbai');
  });
});

describe('codToPrepaid expiration', () => {
  it('computes expiresAt for by_duration freeze mode', () => {
    const before = Date.now();
    const inTwoHours = computeExpiresAt('by_duration', 2, 'h');
    assert.ok(inTwoHours instanceof Date);
    assert.ok(inTwoHours.getTime() >= before + 2 * 60 * 60 * 1000 - 1000);

    const in30Min = computeExpiresAt('by_duration', 30, 'm');
    assert.ok(in30Min.getTime() >= before + 30 * 60 * 1000 - 1000);
    assert.equal(computeExpiresAt('by_fulfillment_status', 2, 'h'), null);
  });
});

describe('codToPrepaid outcome evaluation', () => {
  it('gates converted branch on sequence context outcome', () => {
    const sequence = {
      sequenceContext: {
        codPrepaidOutcomes: { cod_1: 'converted' },
      },
    };
    const result = evaluateCodPrepaidOutcomeCondition(
      sequence,
      'cod_prepaid_outcome:converted:cod_1'
    );
    assert.equal(result.proceed, true);

    const pending = evaluateCodPrepaidOutcomeCondition(
      { sequenceContext: {} },
      'cod_prepaid_outcome:converted:cod_1'
    );
    assert.equal(pending.proceed, false);
    assert.equal(pending.reason, 'cod_prepaid_outcome_pending');
    assert.equal(pending.defer, true);
  });
});

describe('compileGraphToSteps COD → Prepaid', () => {
  it('compiles cod step with three branch conditions', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'order_placed' }, 0),
      node('cod_1', JOURNEY_NODE_TYPES.COD_TO_PREPAID, {
        templateName: 'checkout_tpl',
        freezeMode: 'by_duration',
        freezeDurationValue: 2,
        freezeDurationUnit: 'h',
      }, 100),
      node('send_ok', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'follow_up' }, 200),
      node('send_fail', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'fail_tpl' }, 300),
      node('send_conv', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'thanks_tpl' }, 400),
      node('end_1', JOURNEY_NODE_TYPES.END, {}, 500),
    ];
    const edges = [
      edge('e1', 'trigger_1', 'cod_1'),
      edge('e2', 'cod_1', 'send_ok', 'message_sent'),
      edge('e3', 'cod_1', 'send_fail', 'failed'),
      edge('e4', 'cod_1', 'send_conv', 'converted'),
      edge('e5', 'send_ok', 'end_1'),
      edge('e6', 'send_fail', 'end_1'),
      edge('e7', 'send_conv', 'end_1'),
    ];

    const { steps } = compileGraphToSteps({ nodes, edges });
    const codStep = steps.find((s) => s.type === 'cod_prepaid');
    assert.ok(codStep);
    assert.equal(codStep.templateName, 'checkout_tpl');
    assert.equal(codStep.freezeMode, 'by_duration');

    const followUp = steps.find((s) => s.templateName === 'follow_up');
    const failStep = steps.find((s) => s.templateName === 'fail_tpl');
    const convStep = steps.find((s) => s.templateName === 'thanks_tpl');
    assert.equal(followUp.condition, 'cod_prepaid_outcome:message_sent:cod_1');
    assert.equal(failStep.condition, 'cod_prepaid_outcome:failed:cod_1');
    assert.equal(convStep.condition, 'cod_prepaid_outcome:converted:cod_1');
  });
});
