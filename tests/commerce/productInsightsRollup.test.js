'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProductMeta,
  inferProductFromUrl,
  dateKey,
  mergePixelWithOrderStats,
  productGroupKey,
  resolveProductInsightsDataMode,
} = require('../../utils/commerce/productInsightsRollup');
const { dedupeOrdersByShopifyKey } = require('../../utils/commerce/orderDedupe');
const { hasDbPixelRegistration } = require('../../utils/commerce/trackingInstallStatus');
const { istDateRangeStrings, startOfDayForDateStrIST } = require('../../utils/core/queryHelpers');

test('normalizeProductMeta accepts productId from web pixel payload', () => {
  const meta = normalizeProductMeta({
    product: {
      productId: 'gid://shopify/Product/123',
      title: 'Silk Kurta',
      handle: 'silk-kurta',
      price: '1999',
    },
  });
  assert.equal(meta.productId, 'gid://shopify/Product/123');
  assert.equal(meta.title, 'Silk Kurta');
  assert.equal(meta.handle, 'silk-kurta');
});

test('normalizeProductMeta falls back to handle key', () => {
  const meta = normalizeProductMeta({
    product: { handle: 'cotton-set' },
  });
  assert.equal(meta.productId, 'handle:cotton-set');
});

test('inferProductFromUrl parses Shopify product path', () => {
  const meta = inferProductFromUrl('https://store.com/products/indigo-kurta?variant=1');
  assert.equal(meta.productId, 'handle:indigo-kurta');
  assert.equal(meta.handle, 'indigo-kurta');
});

test('dateKey returns YYYY-MM-DD', () => {
  assert.equal(dateKey(new Date('2026-06-18T12:00:00Z')), '2026-06-18');
});

test('mergePixelWithOrderStats overlays live order revenue on pixel rows', () => {
  const merged = mergePixelWithOrderStats(
    [
      {
        productId: 'gid://shopify/Product/1',
        title: 'Snowboard',
        views: 40,
        addToCarts: 5,
        purchases: 99,
        revenue: 99999,
      },
    ],
    [{ productId: 'gid://shopify/Product/1', title: 'Snowboard', purchases: 2, revenue: 1500 }]
  );
  assert.equal(merged[0].purchases, 2);
  assert.equal(merged[0].revenue, 1500);
  assert.equal(merged[0].views, 40);
});

test('productGroupKey prefers productId over name', () => {
  assert.equal(productGroupKey({ productId: '123', name: 'Hat' }), '123');
  assert.equal(productGroupKey({ name: 'Hat' }), 'name:Hat');
});

test('dedupeOrdersByShopifyKey collapses duplicate Shopify orders', () => {
  const base = {
    orderNumber: '1001',
    shopifyOrderId: '999',
    createdAt: new Date('2026-06-10'),
    items: [{ name: 'Board', quantity: 2, price: 100 }],
    shippingAddress: { city: 'Mumbai' },
    customerName: 'Test User',
    financialStatus: 'paid',
  };
  const dupes = [
    { ...base, _id: 'a' },
    { ...base, _id: 'b', customerName: 'X' },
    { ...base, _id: 'c', customerName: 'Test User Long' },
  ];
  const out = dedupeOrdersByShopifyKey(dupes);
  assert.equal(out.length, 1);
});

test('deduped line items sum matches single order qty', () => {
  const orders = dedupeOrdersByShopifyKey([
    {
      _id: '1',
      orderNumber: '1001',
      shopifyOrderId: '1',
      createdAt: new Date(),
      items: [{ name: 'Board', quantity: 3, price: 500, productId: 'p1' }],
    },
    {
      _id: '2',
      orderNumber: '1001',
      shopifyOrderId: '1',
      createdAt: new Date(),
      items: [{ name: 'Board', quantity: 3, price: 500, productId: 'p1' }],
    },
  ]);
  let units = 0;
  for (const o of orders) {
    for (const item of o.items) units += item.quantity;
  }
  assert.equal(units, 3);
});

test('istDateRangeStrings returns inclusive IST window', () => {
  const { start, end, days } = istDateRangeStrings(7);
  assert.match(start, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(end, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(days, 7);
  const startMs = startOfDayForDateStrIST(start).getTime();
  const endMs = startOfDayForDateStrIST(end).getTime();
  assert.ok(endMs >= startMs);
});

test('hasDbPixelRegistration true when web pixel id present', () => {
  assert.equal(hasDbPixelRegistration({ shopifyWebPixelId: 'gid://shopify/WebPixel/1' }), true);
  assert.equal(hasDbPixelRegistration({ shopifyTrackingDisabled: true }), false);
  assert.equal(
    hasDbPixelRegistration({
      shopifyTrackingDisabled: true,
      shopifyWebPixelId: 'gid://shopify/WebPixel/1',
    }),
    true
  );
});

test('resolveProductInsightsDataMode returns pixel_storefront without SKU rollup', () => {
  assert.equal(
    resolveProductInsightsDataMode({
      hasStorefrontActivity: true,
      hasProductRollup: false,
      orderActive: true,
    }),
    'pixel_storefront'
  );
});

test('resolveProductInsightsDataMode prefers pixel_products when SKU rollup exists', () => {
  assert.equal(
    resolveProductInsightsDataMode({
      hasStorefrontActivity: true,
      hasProductRollup: true,
      orderActive: false,
    }),
    'pixel_products'
  );
});

test('resolveProductInsightsDataMode falls back to orders without pixel', () => {
  assert.equal(
    resolveProductInsightsDataMode({
      hasStorefrontActivity: false,
      hasProductRollup: false,
      orderActive: true,
    }),
    'orders'
  );
});
