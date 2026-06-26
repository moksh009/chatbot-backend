'use strict';

const { normalizeIndianPhone, indianPhoneSuffix } = require('./normalizeIndianPhone');

/** True when string is a valid Indian mobile (10 digits starting 6–9). */
function isValidIndianMobileSuffix(suffix) {
  return /^[6-9]\d{9}$/.test(String(suffix || ''));
}

/**
 * Extract a plausible Indian mobile from corrupted digit strings (concatenation / double 91).
 */
function extractIndianMobileFromDigits(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length <= 12) return null;

  const candidates = [];
  for (let i = 0; i <= d.length - 10; i += 1) {
    const window = d.slice(i, i + 10);
    if (/^[6-9]\d{9}$/.test(window) && !window.startsWith('91')) {
      candidates.push({ window, i });
    }
  }
  if (!candidates.length) return null;

  const afterCountry = candidates.find((c) => c.i === 2);
  if (afterCountry) return afterCountry.window;

  return candidates[0].window;
}

/**
 * Detect 91 prefixed onto US NANP (Shopify test customers: 16135550135 → 9116135550135).
 */
function unwrapUsFromIndianPrefix(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('91')) {
    const tail = d.slice(2);
    if (/^1\d{10}$/.test(tail)) return tail;
  }
  if (d.length > 13 && d.startsWith('91')) {
    const tail = d.slice(2);
    if (/^1\d{10}$/.test(tail)) return tail;
  }
  return null;
}

/**
 * Repair a raw phone to storage digits (919876543210 or 16135550135) — empty when invalid.
 */
function repairPhoneDigits(raw, defaultCountry = 'IN') {
  const country = String(defaultCountry || 'IN').toUpperCase();
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';

  const usUnwrap = unwrapUsFromIndianPrefix(digits);
  if (usUnwrap) return usUnwrap;

  const e164 = normalizeIndianPhone(raw);
  if (e164) return e164.replace(/^\+/, '');

  if (digits.length > 12 && country === 'IN') {
    const extracted = extractIndianMobileFromDigits(digits);
    if (extracted) return `91${extracted}`;
    return '';
  }

  if (digits.length === 11 && digits.startsWith('1')) return digits;

  const suffix = indianPhoneSuffix(digits);
  if (country === 'IN' && isValidIndianMobileSuffix(suffix) && digits.length <= 12) {
    return `91${suffix}`;
  }

  return '';
}

/** AdLead storage — E.164 with leading + (e.g. +919876543210). */
function phoneForAdLeadStorage(raw, defaultCountry = 'IN') {
  const { sanitizePhoneForStorage } = require('./phoneE164Policy');
  return sanitizePhoneForStorage(raw, defaultCountry) || null;
}

/**
 * Pick the best canonical phone from candidates (Shopify/order sources first).
 */
function pickCanonicalPhone(candidates = [], { country = 'IN' } = {}) {
  const countryCode = String(country || 'IN').toUpperCase();
  const seen = new Set();
  const normalized = [];

  for (const raw of candidates) {
    if (raw == null || raw === '') continue;
    const key = String(raw).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const repaired = repairPhoneDigits(key, countryCode);
    if (!repaired) continue;

    const dupKey = repaired;
    if (normalized.some((n) => n.digits === dupKey)) continue;

    normalized.push({
      raw: key,
      digits: repaired,
      isIndian: repaired.length === 12 && repaired.startsWith('91'),
      isUs: repaired.length === 11 && repaired.startsWith('1'),
      index: normalized.length,
    });
  }

  if (!normalized.length) return '';

  const indian = normalized.filter((n) => n.isIndian);
  if (indian.length) return indian[0].digits;

  return normalized[0].digits;
}

function isCorruptedPhoneStorage(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return false;
  if (unwrapUsFromIndianPrefix(digits)) return true;
  if (digits.length > 12) return true;
  if (normalizeIndianPhone(raw)) return false;
  if (digits.length === 11 && digits.startsWith('1')) return false;
  return digits.length >= 10;
}

/** Shopify dev-store Bogus Gateway numbers (+1 613 555 01xx) and placeholders. */
function isShopifyTestPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return true;
  if (/^1?61355501\d{2}$/.test(digits)) return true;
  if (digits.endsWith('0000000000')) return true;
  return false;
}

module.exports = {
  isValidIndianMobileSuffix,
  extractIndianMobileFromDigits,
  unwrapUsFromIndianPrefix,
  repairPhoneDigits,
  phoneForAdLeadStorage,
  pickCanonicalPhone,
  isCorruptedPhoneStorage,
  isShopifyTestPhone,
};
