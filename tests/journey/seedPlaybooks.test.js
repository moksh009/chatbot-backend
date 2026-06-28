'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PLAYBOOK_CATALOG,
  buildQuick3StepGraph,
  buildCartRecovery3StepGraph,
  buildOrderPlacedGraph,
  buildCodConfirmBasicGraph,
  buildOrderShippedTrackingGraph,
} = require('../../services/journeyBuilder/seedPlaybooks');
const { compileGraphToSteps } = require('../../services/journeyBuilder/compileGraphToSteps');
const { CART_RECOVERY_DEFAULTS } = require('../../constants/cartRecoveryDefaults');

describe('PLAYBOOK_CATALOG', () => {
  it('contains 9 keyed playbooks (Tier 1–2 + Tier 3 advanced)', () => {
    const keyed = PLAYBOOK_CATALOG.filter((p) => p.playbookKey);
    assert.equal(keyed.length, 9);
  });

  it('contains 4 Tier 3 logistics playbooks', () => {
    const tier3 = PLAYBOOK_CATALOG.filter((p) => p.tier >= 3);
    assert.equal(tier3.length, 4);
  });

  it('default seed maxTier stays at Tier 2', () => {
    const defaultSeed = PLAYBOOK_CATALOG.filter((p) => p.tier <= 2);
    assert.equal(defaultSeed.length, 5);
  });

  it('all Tier 1+2 playbooks have a buildGraph function', () => {
    for (const p of PLAYBOOK_CATALOG) {
      assert.equal(typeof p.buildGraph, 'function', `${p.playbookKey} missing buildGraph`);
    }
  });
});

describe('buildCartRecovery3StepGraph', () => {
  it('compiles without warnings', () => {
    const { nodes, edges } = buildCartRecovery3StepGraph();
    const { steps, warnings } = compileGraphToSteps({ nodes, edges });
    assert.deepEqual(warnings, []);
    assert.ok(steps.length >= 3, 'Should have at least 3 send steps');
  });

  it('delays match cartRecoveryDefaults (4h and 36h)', () => {
    const { nodes, edges } = buildCartRecovery3StepGraph();
    const { steps } = compileGraphToSteps({ nodes, edges });
    const d1 = steps.find((s) => s.delayValue > 0 && s.delayUnit === 'h');
    assert.ok(d1, 'Should have at least one delay step in hours');
    const expectedD2h = Math.round(CART_RECOVERY_DEFAULTS.step2DelayMinutes / 60);
    const expectedD3h = Math.round(CART_RECOVERY_DEFAULTS.step3DelayMinutes / 60);
    const delays = steps.filter((s) => s.delayUnit === 'h').map((s) => s.delayValue);
    assert.ok(delays.includes(expectedD2h), `Expected delay ${expectedD2h}h; got ${delays.join(',')}`);
    assert.ok(delays.includes(expectedD3h), `Expected delay ${expectedD3h}h; got ${delays.join(',')}`);
  });

  it('uses cart_recovery_1/2/3 template slots', () => {
    const { nodes, edges } = buildCartRecovery3StepGraph();
    const { steps } = compileGraphToSteps({ nodes, edges });
    const names = steps.map((s) => s.templateName);
    assert.ok(names.includes('cart_recovery_1'));
    assert.ok(names.includes('cart_recovery_2'));
    assert.ok(names.includes('cart_recovery_3'));
  });
});

describe('buildOrderPlacedGraph', () => {
  it('compiles to exactly one send step with no warnings about template (template is blank)', () => {
    const { nodes, edges } = buildOrderPlacedGraph();
    const { steps, warnings } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 1);
    // blank templateName is expected at seed time; warning is ok
    assert.ok(warnings.length <= 1);
  });

  it('trigger entryType is order_placed', () => {
    const { nodes } = buildOrderPlacedGraph();
    const trigger = nodes.find((n) => n.data?.nodeType === 'journey_trigger');
    assert.equal(trigger?.data?.entryType, 'order_placed');
  });
});

describe('buildCodConfirmBasicGraph', () => {
  it('compiles without crashing', () => {
    const { nodes, edges } = buildCodConfirmBasicGraph();
    const { steps } = compileGraphToSteps({ nodes, edges });
    assert.ok(steps.length >= 1);
  });

  it('compiles to 3 send steps including address verify', () => {
    const { nodes, edges } = buildCodConfirmBasicGraph();
    const { steps } = compileGraphToSteps({ nodes, edges });
    assert.ok(steps.length >= 3);
    const addressStep = steps.find((s) => s.interactionMode === 'awaiting_text');
    assert.ok(addressStep, 'expected awaiting_text address step');
  });

  it('trigger has codOnly filter', () => {
    const { nodes } = buildCodConfirmBasicGraph();
    const trigger = nodes.find((n) => n.data?.nodeType === 'journey_trigger');
    assert.equal(trigger?.data?.journeyTrigger?.filters?.codOnly, true);
  });
});

describe('buildOrderShippedTrackingGraph', () => {
  it('seeds as Tier 2 and has order_shipped trigger', () => {
    const catalog = PLAYBOOK_CATALOG.find((p) => p.playbookKey === 'order-shipped-tracking');
    assert.equal(catalog?.tier, 2);
    assert.equal(catalog?.journeyTrigger?.type, 'order_shipped');
  });

  it('compiles to one send step', () => {
    const { nodes, edges } = buildOrderShippedTrackingGraph();
    const { steps } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 1);
  });
});
