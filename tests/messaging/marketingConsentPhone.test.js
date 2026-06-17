'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhoneDigits } = require('../../utils/commerce/marketingConsent');

test('normalizePhoneDigits treats DEFAULT_COUNTRY_CODE 91 as India', () => {
  const prev = process.env.DEFAULT_COUNTRY_CODE;
  process.env.DEFAULT_COUNTRY_CODE = '91';
  try {
    assert.equal(normalizePhoneDigits('9876543210'), '919876543210');
    assert.equal(normalizePhoneDigits('919876543210'), '919876543210');
  } finally {
    process.env.DEFAULT_COUNTRY_CODE = prev;
  }
});
