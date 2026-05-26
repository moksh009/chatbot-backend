'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('bundle availability math: min(component/qty)', () => {
  const components = [
    { componentSku: 'A', quantity: 2 },
    { componentSku: 'B', quantity: 1 },
  ];
  const stock = { A: 20, B: 5 };
  let minBundles = Infinity;
  let limiting = null;
  for (const c of components) {
    const bundles = Math.floor(stock[c.componentSku] / c.quantity);
    if (bundles < minBundles) {
      minBundles = bundles;
      limiting = c.componentSku;
    }
  }
  assert.equal(minBundles, 5);
  assert.equal(limiting, 'B');
});

test('backorder FIFO: fulfill min of incoming and queue', () => {
  const backorder = 3;
  const incoming = 10;
  const fulfilled = Math.min(incoming, backorder);
  const remaining = backorder - fulfilled;
  assert.equal(fulfilled, 3);
  assert.equal(remaining, 0);
});
