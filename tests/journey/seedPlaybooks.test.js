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
  it('contains 5 keyed playbooks (Tier 1–2 only)', () => {
    const keyed = PLAYBOOK_CATALOG.filter((p) => p.playbookKey);
    assert.equal(keyed.length, 5);
  });

  it('has no Tier 3 logistics playbooks', () => {
    const tier3 = PLAYBOOK_CATALOG.filter((p) => p.tier >= 3);
    assert.equal(tier3.length, 0);
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
    assert.ok(steps.length >= 6, 'Should have 6 send steps (WA + email per nudge)');
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

  it('uses cart_recovery_1/2/3 template slots and paired emails', () => {
    const { nodes, edges } = buildCartRecovery3StepGraph();
    const { steps } = compileGraphToSteps({ nodes, edges });
    const waNames = steps.filter((s) => s.type === 'whatsapp').map((s) => s.templateName);
    const emailSubjects = steps.filter((s) => s.type === 'email').map((s) => s.subject);
    assert.ok(waNames.includes('cart_recovery_1'));
    assert.ok(waNames.includes('cart_recovery_2'));
    assert.ok(waNames.includes('cart_recovery_3'));
    assert.equal(emailSubjects.length, 3);
    assert.ok(emailSubjects.every((s) => String(s).trim().length > 0));
  });
});

describe('buildOrderPlacedGraph', () => {
  it('compiles to WhatsApp + email send steps with prebuilt templates', () => {
    const { nodes, edges } = buildOrderPlacedGraph();
    const { steps, warnings } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 2);
    assert.deepEqual(warnings, []);
    assert.equal(steps[0].type, 'whatsapp');
    assert.equal(steps[0].templateName, 'order_confirmation_v1');
    assert.equal(steps[1].type, 'email');
    assert.ok(String(steps[1].subject || '').trim().length > 0);
  });

  it('compiles WhatsApp steps with variable mappings', () => {
    const { nodes, edges } = buildOrderPlacedGraph();
    const { steps } = compileGraphToSteps({ nodes, edges });
    const wa = steps.find((s) => s.type === 'whatsapp');
    assert.ok(wa.variableMappings?.body?.['1'] === 'first_name');
    assert.ok(wa.variableMapping?.['1'] === 'first_name');
  });
});

describe('buildCodConfirmBasicGraph', () => {
  it('compiles without crashing', () => {
    const { nodes, edges } = buildCodConfirmBasicGraph();
    const { steps } = compileGraphToSteps({ nodes, edges });
    assert.ok(steps.length >= 4);
  });

  it('compiles to COD + email + cancel + address verify steps', () => {
    const { nodes, edges } = buildCodConfirmBasicGraph();
    const { steps } = compileGraphToSteps({ nodes, edges });
    assert.ok(steps.length >= 4);
    const codStep = steps.find((s) => s.templateName === 'cod_confirmation_v1');
    assert.ok(codStep, 'expected cod_confirmation_v1 step');
    const addressStep = steps.find((s) => s.interactionMode === 'awaiting_text');
    assert.ok(addressStep, 'expected awaiting_text address step');
    const emailSteps = steps.filter((s) => s.type === 'email');
    assert.ok(emailSteps.length >= 2);
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

  it('compiles to WhatsApp + email with prebuilt templates', () => {
    const { nodes, edges } = buildOrderShippedTrackingGraph();
    const { steps, warnings } = compileGraphToSteps({ nodes, edges });
    assert.equal(steps.length, 2);
    assert.deepEqual(warnings, []);
    assert.equal(steps[0].templateName, 'order_shipped_v1');
    assert.equal(steps[1].type, 'email');
  });
});
