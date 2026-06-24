'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { capVelocity, deltaPct } = require('../../../utils/commerce/winningProducts/velocityCalculator');
const { classifyProduct, CLASSIFICATIONS } = require('../../../utils/commerce/winningProducts/storyClassifier');
const { buildProductNarrative, detectBottleneck } = require('../../../utils/commerce/winningProducts/narrativeBuilder');
const { hashEmail, hashPhone, normalizePhoneForMeta } = require('../../../utils/commerce/winningProducts/hashContacts');
const { classifyEventSource } = require('../../../utils/commerce/winningProducts/sourceClassifier');
const { buildRealtimeAlerts } = require('../../../utils/commerce/winningProducts/realtimeAlerts');
const {
  buildWinningProductsCompareFromWorkspace,
} = require('../../../utils/commerce/winningProducts/winningProductsAggregator');

test('capVelocity limits spike ratios', () => {
  assert.equal(capVelocity(25), 10);
  assert.equal(capVelocity(2.5), 2.5);
});

test('deltaPct handles zero previous period', () => {
  assert.equal(deltaPct(10, 0), 100);
  assert.equal(deltaPct(0, 0), 0);
  assert.equal(deltaPct(15, 10), 50);
});

test('classifyProduct marks INSUFFICIENT_DATA when cart adds but no views', () => {
  const c = classifyProduct({
    stats: { views: 0, purchases: 0, revenue: 0, addToCarts: 3 },
    velocity: { viewVelocity: 0 },
    daysOfData: 30,
    daysSinceLastEvent: 1,
    medianTopRevenue: 1000,
  });
  assert.equal(c, CLASSIFICATIONS.INSUFFICIENT_DATA);
});

test('classifyProduct marks WINNING by revenue when views unknown', () => {
  const c = classifyProduct({
    stats: { views: 0, purchases: 4, revenue: 3000, addToCarts: 2, viewsEstimated: true },
    velocity: { viewVelocity: 0 },
    daysOfData: 30,
    daysSinceLastEvent: 1,
    medianTopRevenue: 2000,
  });
  assert.equal(c, CLASSIFICATIONS.WINNING);
});

test('classifyProduct marks STALLED when views high and zero sales', () => {
  const c = classifyProduct({
    stats: { views: 80, purchases: 0, revenue: 0, addToCarts: 5 },
    velocity: { viewVelocity: 1 },
    daysOfData: 30,
    daysSinceLastEvent: 2,
    medianTopRevenue: 1000,
  });
  assert.equal(c, CLASSIFICATIONS.STALLED);
});

test('classifyProduct marks RISING on velocity spike', () => {
  const c = classifyProduct({
    stats: { views: 120, purchases: 1, revenue: 500, addToCarts: 10 },
    velocity: { viewVelocity: 3 },
    daysOfData: 30,
    daysSinceLastEvent: 1,
    medianTopRevenue: 5000,
  });
  assert.equal(c, CLASSIFICATIONS.RISING);
});

test('detectBottleneck flags product page leak', () => {
  assert.equal(
    detectBottleneck({ views: 200, addToCart: 5, checkout: 2, purchase: 0 }),
    'product_page'
  );
});

test('buildProductNarrative for rising product', () => {
  const text = buildProductNarrative({
    product: { title: 'Silk Kurta' },
    stats: { views: 200, addToCarts: 20, purchases: 2 },
    classification: CLASSIFICATIONS.RISING,
    funnel: { views: 200, addToCart: 20, checkout: 5, purchase: 2 },
    velocity: { viewVelocity: 2.5 },
    days: 30,
  });
  assert.match(text, /momentum is building/i);
});

test('hashPhone normalizes Indian 10-digit numbers', () => {
  const normalized = normalizePhoneForMeta('9876543210', '91');
  assert.equal(normalized, '919876543210');
  const hash = hashPhone('9876543210');
  assert.equal(hash?.length, 64);
});

test('hashEmail lowercases before hash', () => {
  const a = hashEmail('Test@Example.com');
  const b = hashEmail('test@example.com');
  assert.equal(a, b);
});

test('classifyEventSource detects paid utm medium', () => {
  assert.equal(classifyEventSource({ utm_medium: 'cpc' }), 'paid');
  assert.equal(classifyEventSource({ referrer: 'https://www.google.com/search' }), 'search');
});

test('buildRealtimeAlerts surfaces rising and audience-ready', () => {
  const alerts = buildRealtimeAlerts(
    [{ title: 'Silk Kurta', classification: 'RISING' }],
    { cartAbandoners: { count: 120, tier: 'minimum' } },
    { lastAudienceTier: 'build' }
  );
  assert.ok(alerts.some((a) => a.type === 'rising'));
  assert.ok(alerts.some((a) => a.type === 'audience_ready'));
});

test('buildWinningProductsCompareFromWorkspace filters selected products', () => {
  const workspace = {
    products: [
      { productId: 'a', title: 'A', stats: { views: 10 }, funnel: {}, narrative: 'A story' },
      { productId: 'b', title: 'B', stats: { views: 20 }, funnel: {}, narrative: 'B story' },
      { productId: 'c', title: 'C', stats: { views: 5 }, funnel: {}, narrative: 'C story' },
    ],
  };
  const result = buildWinningProductsCompareFromWorkspace(workspace, ['a', 'c']);
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].productId, 'a');
});
