'use strict';

/**
 * Canonical Indian phone validation for Website Opt-In Tools (server-side).
 * Mirrors storefront logic in public/topedge-opt-in-phone.js.
 */
const {
  normalizeIndianPhone,
  indianPhoneLookupVariants,
  indianPhoneSuffix,
  isValidIndianMobileInput,
} = require('../core/normalizeIndianPhone');

const OPT_IN_PHONE_ERROR = 'Valid 10-digit Indian mobile required';

function validateOptInPhoneInput(raw) {
  const stored = normalizeIndianPhone(raw);
  if (!stored || !isValidIndianMobileInput(raw)) {
    return { ok: false, stored: null, message: OPT_IN_PHONE_ERROR };
  }
  return { ok: true, stored, message: '' };
}

module.exports = {
  normalizeIndianPhone,
  indianPhoneLookupVariants,
  indianPhoneSuffix,
  isValidIndianMobileInput,
  validateOptInPhoneInput,
  OPT_IN_PHONE_ERROR,
};
