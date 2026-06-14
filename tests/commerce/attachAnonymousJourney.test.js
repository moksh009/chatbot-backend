'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatJourneyLogEntry,
} = require('../../utils/commerce/attachAnonymousJourney');

describe('attachAnonymousJourney', () => {
  it('formatJourneyLogEntry labels page views', () => {
    const row = formatJourneyLogEntry({
      eventName: 'page_view',
      url: 'https://store.com/products/kurti',
      timestamp: new Date(),
    });
    assert.equal(row.action, 'pixel_journey');
    assert.match(row.details, /Viewed page/);
  });
});
