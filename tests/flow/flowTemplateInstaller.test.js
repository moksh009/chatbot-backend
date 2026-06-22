'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listTemplateCatalog, getTemplateDefinition } = require('../../utils/flow/flowTemplateCatalog');
const { generateTemplateGraph } = require('../../utils/flow/flowTemplateInstaller');

const mockClient = {
  clientId: 'tpl_test_client',
  businessName: 'Demo D2C Store',
  name: 'Demo D2C Store',
  platformVars: { brandName: 'Demo D2C Store', agentName: 'Aisha' },
  ai: { persona: { name: 'Aisha', tone: 'friendly' } },
  wizardFeatures: {},
  onboardingData: {},
};

test('listTemplateCatalog returns one complete store template', () => {
  const list = listTemplateCatalog();
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'store_bot_complete');
  assert.ok(list[0].name && list[0].description);
});

test('generateTemplateGraph passes integrity for store_bot_complete', async () => {
  const def = getTemplateDefinition('store_bot_complete');
  assert.ok(def, 'missing definition for store_bot_complete');
  const graph = await generateTemplateGraph(mockClient, def);
  assert.ok(graph.nodes.length > 5, 'store_bot_complete should have nodes');
  assert.ok(graph.edges.length > 0, 'store_bot_complete should have edges');
  assert.equal(graph.slug, 'store_bot_complete');
});
