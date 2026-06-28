'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseJourneyButton, findAwaitingTextStepIndex } = require('../../services/journeyBuilder/journeyInteractiveRouter');

describe('parseJourneyButton', () => {
  it('parses valid jrn_ button payload', () => {
    const result = parseJourneyButton('jrn_507f1f77bcf86cd799439011_1_cod_confirm');
    assert.ok(result);
    assert.equal(result.format, 'jrn');
    assert.equal(result.enrollmentId, '507f1f77bcf86cd799439011');
    assert.equal(result.stepIndex, 1);
    assert.equal(result.action, 'cod_confirm');
  });

  it('parses cod_cancel action', () => {
    const result = parseJourneyButton('jrn_507f1f77bcf86cd799439011_0_cod_cancel');
    assert.ok(result);
    assert.equal(result.action, 'cod_cancel');
    assert.equal(result.stepIndex, 0);
  });

  it('parses advance action', () => {
    const result = parseJourneyButton('jrn_507f1f77bcf86cd799439011_2_advance');
    assert.ok(result);
    assert.equal(result.action, 'advance');
    assert.equal(result.stepIndex, 2);
  });

  it('returns null for legacy rto payload', () => {
    const result = parseJourneyButton('rto_cod_confirm_1042');
    assert.equal(result, null);
  });

  it('returns null for empty string', () => {
    const result = parseJourneyButton('');
    assert.equal(result, null);
  });

  it('returns null for arbitrary text', () => {
    const result = parseJourneyButton('hello_world');
    assert.equal(result, null);
  });

  it('returns null when enrollmentId is not a valid ObjectId hex', () => {
    const result = parseJourneyButton('jrn_notanobjectid_0_cod_confirm');
    assert.equal(result, null);
  });
});

describe('compileGraphToSteps — interactionMode', () => {
  const { compileGraphToSteps } = require('../../services/journeyBuilder/compileGraphToSteps');
  const { JOURNEY_NODE_TYPES } = require('../../services/journeyBuilder/journeyNodeContract');

  function node(id, type, data, y) {
    return { id, type, position: { x: 80, y }, data: { nodeType: type, ...data } };
  }

  it('sets interactionMode=awaiting_button for codConfirmTemplate nodes', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'order_placed' }, 0),
      node('send_1', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'cod_confirm_tpl', codConfirmTemplate: true }, 100),
      node('end_1', JOURNEY_NODE_TYPES.END, {}, 200),
    ];
    const edges = [
      { id: 'e1', source: 'trigger_1', target: 'send_1' },
      { id: 'e2', source: 'send_1', target: 'end_1' },
    ];

    const { steps } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].interactionMode, 'awaiting_button');
    assert.ok(steps[0].expectedActions.includes('cod_confirm'));
    assert.ok(steps[0].expectedActions.includes('cod_cancel'));
  });

  it('sets interactionMode=none for normal send nodes', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'manual' }, 0),
      node('send_1', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'order_confirm' }, 100),
      node('end_1', JOURNEY_NODE_TYPES.END, {}, 200),
    ];
    const edges = [
      { id: 'e1', source: 'trigger_1', target: 'send_1' },
      { id: 'e2', source: 'send_1', target: 'end_1' },
    ];

    const { steps } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].interactionMode, 'none');
    assert.deepEqual(steps[0].expectedActions, []);
  });

  it('sets interactionMode=awaiting_text for addressVerifyTemplate nodes', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'order_placed' }, 0),
      node('send_1', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'addr_tpl', addressVerifyTemplate: true }, 100),
      node('end_1', JOURNEY_NODE_TYPES.END, {}, 200),
    ];
    const edges = [
      { id: 'e1', source: 'trigger_1', target: 'send_1' },
      { id: 'e2', source: 'send_1', target: 'end_1' },
    ];

    const { steps } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].interactionMode, 'awaiting_text');
    assert.ok(steps[0].expectedActions.includes('address_text'));
  });
});

describe('findAwaitingTextStepIndex', () => {
  it('returns index for sent awaiting_text step', () => {
    const idx = findAwaitingTextStepIndex({
      steps: [
        { interactionMode: 'none', status: 'sent' },
        { interactionMode: 'awaiting_text', status: 'sent' },
      ],
    });
    assert.equal(idx, 1);
  });

  it('returns -1 when no awaiting_text step', () => {
    const idx = findAwaitingTextStepIndex({
      steps: [{ interactionMode: 'awaiting_button', status: 'sent' }],
    });
    assert.equal(idx, -1);
  });
});
