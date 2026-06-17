'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AdLead = require('../../models/AdLead');
const SuppressionList = require('../../models/SuppressionList');
const {
  detectSourceType,
  buildCampaignAudienceSnapshot,
} = require('../../services/campaignAudienceSnapshot');

test('detectSourceType identifies csv frozen list', () => {
  assert.equal(
    detectSourceType({ audience: [{ phone: '919999999999' }], csvFile: '/tmp/x.csv' }),
    'csv'
  );
});

test('detectSourceType identifies segment campaign', () => {
  assert.equal(detectSourceType({ segmentId: '507f1f77bcf86cd799439011' }), 'segment');
});

test('buildCampaignAudienceSnapshot counts CSV audience rows', async () => {
  const originalFindSuppression = SuppressionList.find;
  const originalFindLead = AdLead.find;
  try {
    SuppressionList.find = () => ({
      select: () => ({
        lean: async () => [],
      }),
    });
    AdLead.find = () => ({
      select: () => ({
        lean: async () => [],
      }),
    });

    const campaign = {
      _id: '507f1f77bcf86cd799439011',
      clientId: 'test_client',
      channel: 'whatsapp',
      csvFile: '/tmp/upload.csv',
      audienceCount: 3,
      audience: [
        { phone: '919111111111', name: 'A' },
        { phone: '919222222222', name: 'B' },
        { phone: '919333333333', name: 'C' },
      ],
    };
    const snapshot = await buildCampaignAudienceSnapshot(campaign);
    assert.equal(snapshot.total, 3);
    assert.equal(snapshot.willSend, 3);
    assert.equal(snapshot.sourceType, 'csv');
    assert.equal(snapshot.audienceCount, 3);
  } finally {
    SuppressionList.find = originalFindSuppression;
    AdLead.find = originalFindLead;
  }
});
