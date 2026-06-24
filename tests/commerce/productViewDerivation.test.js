'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferProductFromUrl, isProductPageUrl } = require('../../utils/commerce/productViewUrlUtils');

test('inferProductFromUrl extracts handle from product URL', () => {
  const meta = inferProductFromUrl('https://store.myshopify.com/products/snowboard-liquid?variant=1');
  assert.equal(meta.handle, 'snowboard-liquid');
  assert.equal(meta.productId, 'handle:snowboard-liquid');
});

test('inferProductFromUrl handles relative product paths', () => {
  const meta = inferProductFromUrl('/products/snowboard-liquid');
  assert.equal(meta.handle, 'snowboard-liquid');
  assert.equal(meta.productId, 'handle:snowboard-liquid');
});

test('inferProductFromUrl returns null for non-product paths', () => {
  assert.equal(inferProductFromUrl('https://store.myshopify.com/collections/all'), null);
  assert.equal(inferProductFromUrl('https://store.myshopify.com/'), null);
});

test('isProductPageUrl detects product pages', () => {
  assert.equal(isProductPageUrl('https://x.com/products/foo'), true);
  assert.equal(isProductPageUrl('/products/foo'), true);
  assert.equal(isProductPageUrl('https://x.com/pages/about'), false);
});
