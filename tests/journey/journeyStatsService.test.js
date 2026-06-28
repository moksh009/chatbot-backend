'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePeriod,
  MIN_SAMPLE_SIZE,
} = require('../../services/journeyBuilder/journeyStatsService');

describe('journeyStatsService', () => {
  describe('parsePeriod', () => {
    it('parses 7d period with from date', () => {
      const p = parsePeriod('7d');
      assert.ok(p.from instanceof Date);
      assert.ok(p.to instanceof Date);
      assert.equal(p.label, '7d');
      assert.ok(p.to.getTime() - p.from.getTime() >= 6 * 24 * 60 * 60 * 1000);
    });

    it('all-time has null from', () => {
      const p = parsePeriod('all');
      assert.equal(p.from, null);
      assert.equal(p.label, 'all');
    });
  });

  describe('MIN_SAMPLE_SIZE', () => {
    it('is 10 per honest metrics contract', () => {
      assert.equal(MIN_SAMPLE_SIZE, 10);
    });
  });
});

describe('journeyAttributionHelper', () => {
  const { updateJourneyStepStatus } = require('../../utils/commerce/journeyAttributionHelper');

  it('updateJourneyStepStatus returns false without messageId', async () => {
    const result = await updateJourneyStepStatus({ messageId: '', status: 'read' });
    assert.equal(result, false);
  });
});
