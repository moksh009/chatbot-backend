'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enrichRetargetingDisplay,
  buildStorefrontFunnelSummary,
  funnelDropPct,
  metaReadinessTier,
} = require('../../utils/commerce/storefrontPixelMetrics');

test('metaReadinessTier marks minimum at 100 unique sessions', () => {
  const tier = metaReadinessTier(120);
  assert.equal(tier.tier, 'minimum');
  assert.equal(tier.canRetarget, true);
});

test('funnelDropPct returns null when from count is zero', () => {
  assert.equal(funnelDropPct(0, 5), null);
  assert.equal(funnelDropPct(10, 3), 70);
});

test('funnelDropPct returns null when to exceeds from (mixed sources)', () => {
  assert.equal(funnelDropPct(3, 5), null);
  assert.equal(funnelDropPct(2, 3), null);
});

test('enrichRetargetingDisplay prefers session counts over raw events', () => {
  const audiences = {
    segments: {
      uniqueVisitors: { count: 3 },
      addToCart: { count: 1 },
      checkoutStarted: { count: 2 },
      checkoutAbandoned: { count: 1 },
    },
    pageViewEvents: 36,
    addToCartEvents: 1,
    checkoutStartedEvents: 2,
    checkoutCompletedEvents: 1,
  };
  const enriched = enrichRetargetingDisplay(audiences, { pageViews: 36, addToCart: 1, checkoutStarted: 2 });
  assert.equal(enriched.display.storeVisitors.count, 3);
  assert.equal(enriched.display.storeVisitors.basis, 'sessions');
  assert.equal(enriched.display.addToCart.count, 1);
  assert.equal(enriched.display.checkoutStarted.count, 2);
  assert.equal(enriched.display.leftCheckout.count, 1);
});

test('enrichRetargetingDisplay falls back to raw page views when no sessions', () => {
  const audiences = {
    segments: {
      uniqueVisitors: { count: 0 },
      addToCart: { count: 0 },
      checkoutStarted: { count: 0 },
      checkoutAbandoned: { count: 0 },
    },
    pageViewEvents: 36,
    addToCartEvents: 1,
    checkoutStartedEvents: 2,
    checkoutCompletedEvents: 0,
  };
  const enriched = enrichRetargetingDisplay(audiences, null);
  assert.equal(enriched.display.storeVisitors.count, 36);
  assert.equal(enriched.display.storeVisitors.basis, 'page_views');
  assert.equal(enriched.display.addToCart.count, 1);
});

test('buildStorefrontFunnelSummary mirrors tracking tab display counts', () => {
  const audiences = {
    segments: {
      uniqueVisitors: { count: 3 },
      addToCart: { count: 1 },
      checkoutStarted: { count: 2 },
      checkoutAbandoned: { count: 1 },
    },
    pageViewEvents: 36,
    addToCartEvents: 1,
    checkoutStartedEvents: 2,
    uniqueSessionCount: 4,
  };
  const funnel = buildStorefrontFunnelSummary(audiences, { pageViews: 36, addToCart: 1, checkoutStarted: 2 });
  assert.equal(funnel.storeVisitors, 3);
  assert.equal(funnel.addToCart, 1);
  assert.equal(funnel.checkoutStarted, 2);
  assert.equal(funnel.leftCheckout, 1);
  assert.equal(funnel.pageViewEvents, 36);
});
