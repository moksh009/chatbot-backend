'use strict';

/**
 * Phone validation for Website Opt-In Tools (server-side).
 * Mirrors storefront logic in public/topedge-opt-in-phone.js.
 */
const {
  normalizeIndianPhone,
  indianPhoneLookupVariants,
  indianPhoneSuffix,
  isValidIndianMobileInput,
} = require('../core/normalizeIndianPhone');

const OPT_IN_PHONE_ERROR = 'Enter a valid mobile number for the selected country';

const COUNTRY_FLAGS = {
  '+91': 'IN',
  '+1': 'US',
  '+44': 'GB',
  '+971': 'AE',
  '+966': 'SA',
  '+65': 'SG',
};

function normalizeCountryCode(value) {
  const s = String(value || '+91').trim();
  if (!s) return '+91';
  if (s.startsWith('+')) return s;
  return `+${s.replace(/\D/g, '')}`;
}

function digitsOnly(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function isValidPhoneForCountry(raw, countryCode) {
  const code = normalizeCountryCode(countryCode);
  let d = digitsOnly(raw);
  const dialDigits = code.replace(/\D/g, '');

  if (d.startsWith(dialDigits) && d.length > dialDigits.length) {
    d = d.slice(dialDigits.length);
  }
  if (code === '+91') {
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d[0] === '0') d = d.slice(1);
    return d.length === 10 && /^[6-9]/.test(d);
  }
  if (code === '+1') return d.length === 10;
  if (code === '+44') return d.length >= 10 && d.length <= 11;
  if (code === '+971') return d.length === 9;
  if (code === '+966') return d.length === 9;
  if (code === '+65') return d.length === 8;
  return d.length >= 7 && d.length <= 15;
}

function normalizePhoneE164(raw, countryCode) {
  const code = normalizeCountryCode(countryCode);
  let d = digitsOnly(raw);
  const dialDigits = code.replace(/\D/g, '');

  if (d.startsWith(dialDigits) && d.length > dialDigits.length) {
    d = d.slice(dialDigits.length);
  }
  if (code === '+91') {
    const { sanitizePhoneForStorage } = require('../core/phoneE164Policy');
    const stored = sanitizePhoneForStorage(raw, 'IN');
    return stored || null;
  }
  if (!isValidPhoneForCountry(raw, code)) return null;
  return `${code}${d}`;
}

function resolvePhoneConfigFromDesign(design = {}) {
  const phone = design.phone || {};
  return {
    defaultCountryCode: normalizeCountryCode(
      phone.defaultCountryCode || design.fallbackCountryCode || design.countryCode
    ),
  };
}

function validateOptInPhoneInput(raw, countryCode = '+91') {
  const code = normalizeCountryCode(countryCode);
  const stored = normalizePhoneE164(raw, code);
  if (!stored || !isValidPhoneForCountry(raw, code)) {
    return { ok: false, stored: null, message: OPT_IN_PHONE_ERROR, countryCode: code };
  }
  return { ok: true, stored, message: '', countryCode: code };
}

module.exports = {
  normalizeIndianPhone,
  indianPhoneLookupVariants,
  indianPhoneSuffix,
  isValidIndianMobileInput,
  normalizeCountryCode,
  digitsOnly,
  isValidPhoneForCountry,
  normalizePhoneE164,
  resolvePhoneConfigFromDesign,
  validateOptInPhoneInput,
  OPT_IN_PHONE_ERROR,
  COUNTRY_FLAGS,
};
