'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AdLead = require('../../models/AdLead');
const SuppressionList = require('../../models/SuppressionList');
const Segment = require('../../models/Segment');
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

test('buildCampaignAudienceSnapshot counts 10-digit Indian CSV phones with DEFAULT_COUNTRY_CODE=91', async () => {
  const originalFindSuppression = SuppressionList.find;
  const originalFindLead = AdLead.find;
  const prevCc = process.env.DEFAULT_COUNTRY_CODE;
  process.env.DEFAULT_COUNTRY_CODE = '91';
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
      _id: '507f1f77bcf86cd799439012',
      clientId: 'test_client',
      channel: 'whatsapp',
      csvFile: '/tmp/upload.csv',
      audienceCount: 2,
      audience: [
        { phone: '9876543210', name: 'Ten digit' },
        { phone: '919876543211', name: 'E164' },
      ],
    };
    const snapshot = await buildCampaignAudienceSnapshot(campaign);
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.willSend, 2);
    assert.equal(snapshot.sourceType, 'csv');
  } finally {
    process.env.DEFAULT_COUNTRY_CODE = prevCc;
    SuppressionList.find = originalFindSuppression;
    AdLead.find = originalFindLead;
  }
});

test('buildCampaignAudienceSnapshot counts email CSV rows', async () => {
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
      _id: '507f1f77bcf86cd799439013',
      clientId: 'test_client',
      channel: 'email',
      csvFile: '/tmp/emails.csv',
      audienceCount: 3,
      audience: [
        { email: 'a@example.com', name: 'A' },
        { email: 'b@example.com', name: 'B' },
        { email: 'c@example.com', name: 'C' },
      ],
    };
    const snapshot = await buildCampaignAudienceSnapshot(campaign);
    assert.equal(snapshot.total, 3);
    assert.equal(snapshot.willSend, 3);
    assert.equal(snapshot.sourceType, 'csv');
  } finally {
    SuppressionList.find = originalFindSuppression;
    AdLead.find = originalFindLead;
  }
});

test('buildCampaignAudienceSnapshot resolves segment audience with opt-out exclusion', async () => {
  const originalFindSuppression = SuppressionList.find;
  const originalFindLead = AdLead.find;
  const originalSegFind = Segment.findOne;
  try {
    SuppressionList.find = () => ({
      select: () => ({
        lean: async () => [],
      }),
    });
    Segment.findOne = () => ({
      lean: async () => ({ _id: 'seg1', query: { leadScore: { $gte: 50 } } }),
    });
    AdLead.find = () => ({
      select: () => ({
        lean: async () => [
          { phoneNumber: '919111111111', optStatus: 'opted_in', name: 'A' },
          { phoneNumber: '919222222222', optStatus: 'opted_out', name: 'B' },
        ],
      }),
    });

    const campaign = {
      _id: '507f1f77bcf86cd799439014',
      clientId: 'test_client',
      channel: 'whatsapp',
      segmentId: '507f1f77bcf86cd799439011',
      audienceCount: 2,
    };
    const snapshot = await buildCampaignAudienceSnapshot(campaign);
    assert.equal(snapshot.sourceType, 'segment');
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.willSend, 1);
    assert.equal(snapshot.optedOut, 1);
  } finally {
    SuppressionList.find = originalFindSuppression;
    AdLead.find = originalFindLead;
    Segment.findOne = originalSegFind;
  }
});
