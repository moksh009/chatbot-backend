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
      { id: 'e1', source: 'trigger_1', target: 'send_1' },
      { id: 'e2', source: 'send_1', target: 'wait_1' },
      { id: 'e3', source: 'wait_1', target: 'send_2' },
      { id: 'e4', source: 'send_2', target: 'end_1' },
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
    const edges = [{ id: 'e1', source: 'trigger_1', target: 'end_1' }];
    const { steps, warnings } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 0);
    assert.ok(warnings.some((w) => /no send/i.test(w)));
  });
});
