'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DRAFT_ORDER_CREATE_MUTATION,
  DRAFT_ORDER_DELETE_MUTATION,
} = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidShopify');
const { isCodFulfillmentExpiryTrigger } = require('../../services/journeyBuilder/codToPrepaid/codToPrepaidWebhookHandler');

describe('Part 4 — Shopify GraphQL mutations (exact structure)', () => {
  it('draftOrderCreate mutation matches spec', () => {
    assert.match(DRAFT_ORDER_CREATE_MUTATION, /mutation draftOrderCreate\(\$input: DraftOrderInput!\)/);
    assert.match(DRAFT_ORDER_CREATE_MUTATION, /invoiceUrl/);
    assert.match(DRAFT_ORDER_CREATE_MUTATION, /userErrors/);
  });

  it('draftOrderDelete mutation matches spec', () => {
    assert.match(DRAFT_ORDER_DELETE_MUTATION, /mutation draftOrderDelete\(\$input: DraftOrderDeleteInput!\)/);
    assert.match(DRAFT_ORDER_DELETE_MUTATION, /deletedId/);
  });
});

describe('Part 5 — fulfillment expiry trigger', () => {
  it('fires on in_progress and fulfilled statuses', () => {
    assert.equal(isCodFulfillmentExpiryTrigger('in_progress'), true);
    assert.equal(isCodFulfillmentExpiryTrigger('fulfilled'), true);
    assert.equal(isCodFulfillmentExpiryTrigger('success'), true);
    assert.equal(isCodFulfillmentExpiryTrigger('pending'), false);
    assert.equal(isCodFulfillmentExpiryTrigger(''), false);
  });
});

describe('Part 5 — expiration cron query shape', () => {
  it('exports runTick for coordinator 2-minute bundle', () => {
    const cronPath = require.resolve('../../cron/codToPrepaidExpirationCron');
    delete require.cache[cronPath];
    const cron = require('../../cron/codToPrepaidExpirationCron');
    assert.equal(typeof cron.runTick, 'function');
    assert.equal(typeof cron.expireOneRecord, 'function');
  });
});
