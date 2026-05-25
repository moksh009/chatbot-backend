'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeEmail,
  filterAudienceForEmailOptIn,
  audienceOptQueryForCampaign,
} = require('../utils/commerce/marketingConsent');

describe('email campaign consent', () => {
  it('normalizeEmail rejects invalid', () => {
    assert.equal(normalizeEmail(''), '');
    assert.equal(normalizeEmail('a@b.com'), 'a@b.com');
  });

  it('audienceOptQueryForCampaign uses email consent fields', () => {
    const q = audienceOptQueryForCampaign({ channel: 'email', templateCategory: 'MARKETING' });
    assert.deepEqual(q, { 'channelConsent.email.status': 'opted_in' });
  });
});
