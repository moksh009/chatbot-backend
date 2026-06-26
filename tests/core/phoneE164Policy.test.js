'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizePhoneForStorage,
  stripPhoneFormatting,
  phoneStorageLookupVariants,
} = require('../../utils/core/phoneE164Policy');

test('sanitizePhoneForStorage returns compact E.164 for India', () => {
  assert.equal(sanitizePhoneForStorage('9876543210'), '+919876543210');
  assert.equal(sanitizePhoneForStorage('+91 98765 43210'), '+919876543210');
  assert.equal(sanitizePhoneForStorage('91-9876543210'), '+919876543210');
  assert.equal(sanitizePhoneForStorage('9313045439'), '+919313045439');
  assert.equal(sanitizePhoneForStorage('+9313045439'), '+919313045439');
  assert.equal(sanitizePhoneForStorage('919313045439'), '+919313045439');
});

test('sanitizePhoneForStorage returns empty for invalid input', () => {
  assert.equal(sanitizePhoneForStorage(''), '');
  assert.equal(sanitizePhoneForStorage(null), '');
});

test('stripPhoneFormatting removes spaces and brackets', () => {
  assert.equal(stripPhoneFormatting('(919) 876-543210'), '919876543210');
});

test('phoneStorageLookupVariants includes E.164 and legacy forms', () => {
  const variants = phoneStorageLookupVariants('9876543210');
  assert.ok(variants.includes('+919876543210'));
  assert.ok(variants.includes('919876543210'));
});
