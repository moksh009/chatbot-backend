'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateOptInPhoneInput,
  isValidIndianMobileInput,
  OPT_IN_PHONE_ERROR,
} = require('../../utils/optIn/indianPhoneValidator');

describe('optIn indianPhoneValidator', () => {
  it('accepts 10-digit mobile starting 6-9', () => {
    const res = validateOptInPhoneInput('9876543210');
    assert.equal(res.ok, true);
    assert.equal(res.stored, '+919876543210');
  });

  it('accepts +91 prefix and strips leading zero', () => {
    assert.equal(validateOptInPhoneInput('+91 98765 43210').ok, true);
    assert.equal(validateOptInPhoneInput('09876543210').ok, true);
  });

  it('rejects invalid numbers with shared error message', () => {
    const res = validateOptInPhoneInput('5123456789');
    assert.equal(res.ok, false);
    assert.equal(res.message, OPT_IN_PHONE_ERROR);
    assert.equal(isValidIndianMobileInput('123'), false);
  });
});
