'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeIndianPhone } = require('../../utils/core/normalizeIndianPhone');

test('normalizeIndianPhone — 10-digit national', () => {
  assert.strictEqual(normalizeIndianPhone('9876543210'), '+919876543210');
});

test('normalizeIndianPhone — 91 prefix without plus', () => {
  assert.strictEqual(normalizeIndianPhone('919876543210'), '+919876543210');
});

test('normalizeIndianPhone — E.164 with plus', () => {
  assert.strictEqual(normalizeIndianPhone('+919876543210'), '+919876543210');
});

test('normalizeIndianPhone — spaced and dashed', () => {
  assert.strictEqual(normalizeIndianPhone('+91 98765 43210'), '+919876543210');
  assert.strictEqual(normalizeIndianPhone('+91-9876543210'), '+919876543210');
});

test('normalizeIndianPhone — leading zero trunk', () => {
  assert.strictEqual(normalizeIndianPhone('09876543210'), '+919876543210');
});

test('normalizeIndianPhone — invalid returns null', () => {
  assert.strictEqual(normalizeIndianPhone('123'), null);
  assert.strictEqual(normalizeIndianPhone(''), null);
});
