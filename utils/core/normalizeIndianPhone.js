'use strict';

/**
 * Normalize Indian mobile numbers to E.164 (+91XXXXXXXXXX).
 * Accepts: 9876543210, 09876543210, +919876543210, 91-9876543210, +91 98765 43210, 919876543210
 * @returns {string|null} E.164 with leading + or null when invalid
 */
function normalizeIndianPhone(raw) {
  if (raw == null || raw === '') return null;

  let cleaned = String(raw).trim().replace(/[\s\-.]/g, '');
  if (!cleaned) return null;

  cleaned = cleaned.replace(/^\+/, '');

  if (/^91\d{10}$/.test(cleaned)) {
    const suffix = cleaned.slice(2);
    if (/^[6-9]\d{9}$/.test(suffix)) {
      return `+${cleaned}`;
    }
  }

  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return `+91${cleaned}`;
  }

  if (/^0[6-9]\d{9}$/.test(cleaned)) {
    return `+91${cleaned.substring(1)}`;
  }

  return null;
}

/** Digits only (919876543210) — legacy AdLead / Conversation keys */
function indianPhoneDigits(e164OrRaw) {
  const e164 = normalizeIndianPhone(e164OrRaw);
  return e164 ? e164.replace(/^\+/, '') : '';
}

/** Both + and digit-only forms for Mongo $in lookups */
function indianPhoneLookupVariants(raw) {
  const e164 = normalizeIndianPhone(raw);
  if (!e164) return [];
  const digits = e164.replace(/^\+/, '');
  const variants = new Set([e164, digits]);
  const suffix = indianPhoneSuffix(raw);
  if (suffix.length >= 8) {
    variants.add(suffix);
    variants.add(`91${suffix}`);
    variants.add(`+91${suffix}`);
  }
  return [...variants];
}

/** Last 10 digits — matches +91, 91, and bare 10-digit storage */
function indianPhoneSuffix(raw) {
  return String(raw || '').replace(/\D/g, '').slice(-10);
}

/** True when two phone strings refer to the same Indian mobile (suffix match) */
function indianPhonesMatch(a, b) {
  const sa = indianPhoneSuffix(a);
  const sb = indianPhoneSuffix(b);
  return sa.length >= 8 && sb.length >= 8 && sa === sb;
}

module.exports = {
  normalizeIndianPhone,
  indianPhoneDigits,
  indianPhoneLookupVariants,
  indianPhoneSuffix,
  indianPhonesMatch,
};
