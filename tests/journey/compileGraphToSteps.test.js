'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { compileGraphToSteps } = require('../../services/journeyBuilder/compileGraphToSteps');
const { JOURNEY_NODE_TYPES } = require('../../services/journeyBuilder/journeyNodeContract');

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

describe('compileGraphToSteps', () => {
  it('compiles trigger → send → wait → send → end into two steps with delays', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'manual' }, 0),
      node('send_1', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'tpl_a' }, 100),
      node('wait_1', JOURNEY_NODE_TYPES.WAIT, { delayValue: 15, delayUnit: 'm' }, 200),
      node('send_2', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'tpl_b' }, 300),
      node('end_1', JOURNEY_NODE_TYPES.END, {}, 400),
    ];
    const edges = [
      edge('e1', 'trigger_1', 'send_1'),
      edge('e2', 'send_1', 'wait_1'),
      edge('e3', 'wait_1', 'send_2'),
      edge('e4', 'send_2', 'end_1'),
    ];

    const anchor = new Date('2026-06-01T10:00:00.000Z');
    const { steps, warnings, cancelOnReply } = compileGraphToSteps({ nodes, edges, anchorTime: anchor });

    assert.deepEqual(warnings, []);
    assert.equal(cancelOnReply, true);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].templateName, 'tpl_a');
    assert.equal(steps[0].delayValue, 0);
    assert.equal(steps[1].templateName, 'tpl_b');
    assert.equal(steps[1].delayValue, 15);
    assert.equal(steps[1].delayUnit, 'm');
  });

  it('returns warning when no send steps', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'manual' }, 0),
      node('end_1', JOURNEY_NODE_TYPES.END, {}, 100),
    ];
    const edges = [edge('e1', 'trigger_1', 'end_1')];
    const { steps, warnings } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 0);
    assert.ok(warnings.some((w) => /no actionable/i.test(w)));
  });

  it('compiles chatbot handoff step', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'manual' }, 0),
      node('handoff_1', JOURNEY_NODE_TYPES.CHATBOT_HANDOFF, {
        targetFlowId: 'flow_abc',
        targetFlowName: 'Support Bot',
      }, 100),
      node('end_1', JOURNEY_NODE_TYPES.END, {}, 200),
    ];
    const edges = [
      edge('e1', 'trigger_1', 'handoff_1'),
      edge('e2', 'handoff_1', 'end_1'),
    ];
    const { steps, warnings } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'flow_handoff');
    assert.equal(steps[0].targetFlowId, 'flow_abc');
    assert.deepEqual(warnings, []);
  });

  it('compiles branch yes/no paths with opposite conditions', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'order_placed' }, 0),
      node('branch_1', JOURNEY_NODE_TYPES.CONDITIONAL_SPLIT, { splitOn: 'Prepaid order only' }, 100),
      node('send_yes', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'tpl_prepaid' }, 200),
      node('send_no', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'tpl_cod' }, 300),
      node('end_yes', JOURNEY_NODE_TYPES.END, {}, 400),
      node('end_no', JOURNEY_NODE_TYPES.END, {}, 500),
    ];
    const edges = [
      edge('e1', 'trigger_1', 'branch_1'),
      edge('e2', 'branch_1', 'send_yes', 'yes'),
      edge('e3', 'branch_1', 'send_no', 'no'),
      edge('e4', 'send_yes', 'end_yes'),
      edge('e5', 'send_no', 'end_no'),
    ];

    const { steps, warnings } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 2);
    assert.equal(steps[0].templateName, 'tpl_prepaid');
    assert.equal(steps[0].condition, 'prepaid_order');
    assert.equal(steps[1].templateName, 'tpl_cod');
    assert.equal(steps[1].condition, 'not_prepaid_order');
    assert.deepEqual(warnings, []);
  });

  it('merges branch paths by sendAt when waits differ per side', () => {
    const anchor = new Date('2026-06-01T10:00:00.000Z');
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'order_placed' }, 0),
      node('branch_1', JOURNEY_NODE_TYPES.CONDITIONAL_SPLIT, { splitOn: 'COD order only' }, 100),
      node('wait_yes', JOURNEY_NODE_TYPES.WAIT, { delayValue: 1, delayUnit: 'h' }, 200),
      node('send_yes', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'tpl_cod' }, 250),
      node('send_no', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'tpl_prepaid' }, 300),
      node('end_yes', JOURNEY_NODE_TYPES.END, {}, 400),
      node('end_no', JOURNEY_NODE_TYPES.END, {}, 500),
    ];
    const edges = [
      edge('e1', 'trigger_1', 'branch_1'),
      edge('e2', 'branch_1', 'wait_yes', 'yes'),
      edge('e3', 'branch_1', 'send_no', 'no'),
      edge('e4', 'wait_yes', 'send_yes'),
      edge('e5', 'send_yes', 'end_yes'),
      edge('e6', 'send_no', 'end_no'),
    ];

    const { steps } = compileGraphToSteps({ nodes, edges, anchorTime: anchor });
    assert.equal(steps.length, 2);
    assert.equal(steps[0].templateName, 'tpl_prepaid');
    assert.equal(steps[0].condition, 'not_cod_order');
    assert.equal(steps[1].templateName, 'tpl_cod');
    assert.equal(steps[1].condition, 'cod_order');
    assert.equal(new Date(steps[0].sendAt).getTime(), anchor.getTime());
    assert.equal(new Date(steps[1].sendAt).getTime(), anchor.getTime() + 3600000);
  });

  it('warns when only yes path is connected on branch', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'manual' }, 0),
      node('branch_1', JOURNEY_NODE_TYPES.CONDITIONAL_SPLIT, { splitOn: 'Prepaid order only' }, 100),
      node('send_yes', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'tpl_a' }, 200),
      node('end_1', JOURNEY_NODE_TYPES.END, {}, 300),
    ];
    const edges = [
      edge('e1', 'trigger_1', 'branch_1'),
      edge('e2', 'branch_1', 'send_yes', 'yes'),
      edge('e3', 'send_yes', 'end_1'),
    ];

    const { steps, warnings } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].condition, 'prepaid_order');
    assert.ok(warnings.some((w) => /no path is not connected/i.test(w)));
  });

  it('warns and compiles yes-only for always-continue branch rule', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'manual' }, 0),
      node('branch_1', JOURNEY_NODE_TYPES.CONDITION, { condition: '' }, 100),
      node('send_yes', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'tpl_a' }, 200),
      node('send_no', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: 'tpl_b' }, 300),
      node('end_1', JOURNEY_NODE_TYPES.END, {}, 400),
    ];
    const edges = [
      edge('e1', 'trigger_1', 'branch_1'),
      edge('e2', 'branch_1', 'send_yes', 'yes'),
      edge('e3', 'branch_1', 'send_no', 'no'),
      edge('e4', 'send_yes', 'end_1'),
    ];

    const { steps, warnings } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].templateName, 'tpl_a');
    assert.ok(warnings.some((w) => /always continue/i.test(w)));
  });

  it('persists email templateName and subject on compiled steps', () => {
    const nodes = [
      node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'order_placed' }, 0),
      node(
        'send_email_1',
        JOURNEY_NODE_TYPES.SEND_EMAIL,
        {
          templateId: 'order_confirmed',
          templateName: 'Order confirmed',
          subject: 'Your order {{order_number}} is confirmed! ✅',
          content: '<p>Thanks for your order</p>',
        },
        100
      ),
      node('end_1', JOURNEY_NODE_TYPES.END, {}, 200),
    ];
    const edges = [
      edge('e1', 'trigger_1', 'send_email_1'),
      edge('e2', 'send_email_1', 'end_1'),
    ];

    const { steps } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'email');
    assert.equal(steps[0].templateName, 'Order confirmed');
    assert.equal(steps[0].subject, 'Your order {{order_number}} is confirmed! ✅');
  });
});
