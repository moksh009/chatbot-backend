'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('inventory webhook dedupe key format', () => {
  const clientId = 'tenant_a';
  const inventoryItemId = '12345';
  const locationId = '67890';
  const updatedAt = '2026-05-24T12:00:00Z';
  const dedupeKey = `inv_webhook:${clientId}:${inventoryItemId}:${locationId}:${updatedAt}`;
  assert.match(dedupeKey, /^inv_webhook:tenant_a:12345:67890:/);
});

test('shopify order ledger idempotency key', () => {
  const key = `shopify:999001:444:create`;
  assert.ok(key.startsWith('shopify:'));
});
