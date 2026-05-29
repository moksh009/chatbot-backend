'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTestTemplatePayload,
  isCartRecoveryTemplateName,
} = require('../../utils/meta/buildTestTemplatePayload');

describe('buildTestTemplatePayload', () => {
  it('detects cart recovery template names', () => {
    assert.equal(isCartRecoveryTemplateName('cart_recovery_1'), true);
    assert.equal(isCartRecoveryTemplateName('eco_order_confirmed'), false);
  });

  it('builds eco_order_confirmed body with four parameters', async () => {
    const synced = {
      name: 'eco_order_confirmed',
      components: [
        { type: 'HEADER', format: 'IMAGE' },
        {
          type: 'BODY',
          text: 'Hi {{1}}, order {{2}} total {{3}} pay {{4}}',
        },
      ],
    };
    const client = {
      clientId: 'test_client',
      businessName: 'Test Store',
      syncedMetaTemplates: [synced],
    };
    const Client = require('../../models/Client');
    const orig = Client.findOne;
    Client.findOne = () => ({ select: () => ({ lean: async () => client }) });

    try {
      const { components } = await buildTestTemplatePayload({
        clientId: 'test_client',
        templateName: 'eco_order_confirmed',
        event: 'paid',
      });
      const body = components.find((c) => c.type === 'body');
      assert.ok(body);
      assert.equal(body.parameters.length, 4);
      assert.ok(body.parameters.every((p) => p.text && p.text !== ''));
    } finally {
      Client.findOne = orig;
    }
  });
});
