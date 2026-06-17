'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AdLead = require('../../models/AdLead');
const { transitionLeadTags } = require('../../utils/commerce/leadTagOps');

test('transitionLeadTags uses single $set pipeline update for tags', async () => {
  const originalUpdateMany = AdLead.updateMany;
  try {
    let capturedPipeline = null;
    AdLead.updateMany = async (_filter, pipeline) => {
      capturedPipeline = pipeline;
      return { matchedCount: 1, modifiedCount: 1 };
    };

    const result = await transitionLeadTags({
      filter: { clientId: 'c1', phoneNumber: '919999999999' },
      add: ['Opted In'],
      remove: ['Opted Out'],
    });

    assert.equal(result.matchedCount, 1);
    assert.ok(Array.isArray(capturedPipeline), 'expected update pipeline array');
    assert.equal(capturedPipeline.length, 1);
    assert.ok(capturedPipeline[0].$set?.tags, 'expected pipeline to set tags field');
  } finally {
    AdLead.updateMany = originalUpdateMany;
  }
});
