'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOrderPhoneQuery,
  buildOrderIdentityQuery,
  dedupeOrders,
  summarizeOrders,
  normalizeEmail,
  buildEmailRegex,
} = require('../utils/customer360/leadLookupHelpers');
const {
  findBestLeadForConversationPhone,
  resolveCanonicalLeadMetrics,
} = require('../utils/commerce/resolveCanonicalLeadMetrics');

test('buildOrderPhoneQuery matches phone and customerPhone variants', () => {
  const q = buildOrderPhoneQuery('client_a', '919876543210');
  assert.equal(q.clientId, 'client_a');
  assert.ok(Array.isArray(q.$or));
  assert.equal(q.$or.length, 2);
  assert.deepEqual(q.$or[0].phone.$in, q.$or[1].customerPhone.$in);
  assert.ok(q.$or[0].phone.$in.includes('919876543210'));
  assert.ok(q.$or[0].phone.$in.includes('9876543210'));
});

test('buildOrderIdentityQuery includes email and linked phones', () => {
  const q = buildOrderIdentityQuery('client_a', {
    phoneNumber: '919876543210',
    email: 'Moksh@Example.com',
    extraPhones: ['918888888888'],
  });
  assert.equal(q.clientId, 'client_a');
  assert.ok(q.$or.some((clause) => clause.customerEmail));
  assert.ok(q.$or.some((clause) => clause.email));
  assert.ok(q.$or.some((clause) => clause.phone?.$in?.includes('8888888888')));
});

test('dedupeOrders keeps latest unique shopify orders', () => {
  const merged = dedupeOrders([
    { shopifyOrderId: '1', createdAt: '2026-06-10', totalPrice: 1000 },
    { shopifyOrderId: '1', createdAt: '2026-06-11', totalPrice: 1000 },
    { orderId: '1007', createdAt: '2026-06-15', totalPrice: 1500 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].orderId, '1007');
});

test('summarizeOrders computes count and LTV', () => {
  const summary = summarizeOrders([
    { shopifyOrderId: '1', totalPrice: 1500, createdAt: '2026-06-14' },
    { shopifyOrderId: '2', amount: 1500, createdAt: '2026-06-15' },
  ]);
  assert.equal(summary.ordersCount, 2);
  assert.equal(summary.totalSpent, 3000);
});

test('normalizeEmail lowercases and validates', () => {
  assert.equal(normalizeEmail('  Moksh@Example.com '), 'moksh@example.com');
  assert.equal(normalizeEmail('invalid'), '');
});

test('buildEmailRegex returns case-insensitive anchored regex for valid emails', () => {
  const regex = buildEmailRegex('Moksh@Example.com');
  assert.ok(regex instanceof RegExp);
  assert.ok(regex.test('moksh@example.com'));
  assert.ok(regex.test('Moksh@Example.com'));
  assert.equal(regex.test('other@example.com'), false);
  assert.equal(buildEmailRegex('invalid'), null);
  assert.equal(buildEmailRegex(''), null);
});

test('resolveCanonicalLeadMetrics exports are callable functions', () => {
  assert.equal(typeof findBestLeadForConversationPhone, 'function');
  assert.equal(typeof resolveCanonicalLeadMetrics, 'function');
});
