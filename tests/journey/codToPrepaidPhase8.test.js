'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  expirationStatusAfterDelete,
} = require('../../cron/codToPrepaidExpirationCron');
const { isRateLimitError } = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidShopify');
const { COD_PREPAID_ACTIVE_STATUSES } = require('../../services/journeyBuilder/journeyTriggerRouter');

describe('Part 8 edge case 1 — cron vs conversion race', () => {
  it('skips status update when record already converted', () => {
    const result = expirationStatusAfterDelete('converted', { notFound: true });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'already_converted');
  });

  it('marks expired_by_timer when draft not found but not yet converted', () => {
    const result = expirationStatusAfterDelete('message_sent', { notFound: true });
    assert.equal(result.action, 'expire');
    assert.equal(result.status, 'expired_by_timer');
    assert.equal(result.lastErrorMessage, 'draft_already_gone');
  });

  it('marks expired_by_timer after successful delete on message_sent', () => {
    const result = expirationStatusAfterDelete('message_sent', { notFound: false });
    assert.equal(result.action, 'expire');
    assert.equal(result.status, 'expired_by_timer');
    assert.equal(result.lastErrorMessage, '');
  });
});

describe('Part 8 edge case 2 — active conversion statuses', () => {
  it('includes non-terminal in-flight statuses for dedupe', () => {
    assert.deepEqual(COD_PREPAID_ACTIVE_STATUSES, [
      'draft_order_pending',
      'draft_order_created',
      'message_sent',
    ]);
  });
});

describe('Part 8 edge case 4 — Shopify rate limit detection', () => {
  it('detects 429, throttling, and rate limit messages', () => {
    assert.equal(isRateLimitError(new Error('HTTP 429 Too Many Requests')), true);
    assert.equal(isRateLimitError(new Error('Throttled')), true);
    assert.equal(isRateLimitError(new Error('API rate limit exceeded')), true);
    assert.equal(isRateLimitError(new Error('draft order not found')), false);
  });
});

describe('Part 8 edge case 5 — duplicate node guard statuses', () => {
  it('treats draft_order_pending and message_sent as active (not terminal)', () => {
    assert.equal(COD_PREPAID_ACTIVE_STATUSES.includes('draft_order_pending'), true);
    assert.equal(COD_PREPAID_ACTIVE_STATUSES.includes('message_sent'), true);
    assert.equal(COD_PREPAID_ACTIVE_STATUSES.includes('converted'), false);
  });
});
