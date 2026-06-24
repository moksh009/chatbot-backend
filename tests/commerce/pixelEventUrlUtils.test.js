'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePixelEventUrl,
  enrichPixelMetadata,
} = require('../../utils/commerce/pixelEventUrlUtils');

test('resolvePixelEventUrl prefers pathname when url is empty', () => {
  const url = resolvePixelEventUrl(
    { metadata: { pathname: '/products/snowboard-liquid' } },
    {}
  );
  assert.equal(url, '/products/snowboard-liquid');
});

test('resolvePixelEventUrl falls back to metadata.url', () => {
  const url = resolvePixelEventUrl(
    { metadata: { url: 'https://demo.myshopify.com/products/foo' } },
    {}
  );
  assert.equal(url, 'https://demo.myshopify.com/products/foo');
});

test('enrichPixelMetadata copies pathname into metadata', () => {
  const { url, metadata } = enrichPixelMetadata(
    { metadata: { pathname: '/products/bar' } },
    {}
  );
  assert.equal(url, '/products/bar');
  assert.equal(metadata.pathname, '/products/bar');
  assert.equal(metadata.url, '/products/bar');
});
