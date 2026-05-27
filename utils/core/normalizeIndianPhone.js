'use strict';

const { parsePhoneNumberFromString } = require('libphonenumber-js');

/**
 * Normalize Indian mobile numbers to E.164 (+91XXXXXXXXXX).
 * Accepts: 9876543210, 919876543210, +919876543210, +91-9876543210, +91 98765 43210
 * @returns {string|null} E.164 with leading + or null when invalid
 */
function normalizeIndianPhone(raw) {
  if (raw == null || raw === '') return null;
  const str = String(raw).trim();
  if (!str) return null;

  try {
    const parsed = parsePhoneNumberFromString(str.startsWith('+') ? str : str, 'IN');
    if (parsed?.isValid() && parsed.country === 'IN') {
      return parsed.format('E.164');
    }
  } catch {
    /* fall through */
  }

  let digits = str.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('0') && digits.length === 11) {
    digits = `91${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `91${digits}`;
  }

  if (digits.startsWith('91') && digits.length === 12) {
    const national = digits.slice(2);
    if (/^[6-9]\d{9}$/.test(national)) {
      return `+${digits}`;
    }
  }

  return null;
}

module.exports = { normalizeIndianPhone };
