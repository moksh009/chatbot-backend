'use strict';

const crypto = require('crypto');

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

function normalizePhoneForMeta(phone, countryCode = '91') {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  let normalized = digits;
  if (normalized.length === 10 && countryCode === '91') {
    normalized = `91${normalized}`;
  } else if (!normalized.startsWith(countryCode) && normalized.length === 10) {
    normalized = `${countryCode}${normalized}`;
  }
  return normalized;
}

function sha256Hex(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashEmail(email) {
  const normalized = normalizeEmail(email);
  return normalized ? sha256Hex(normalized) : null;
}

function hashPhone(phone, countryCode = '91') {
  const normalized = normalizePhoneForMeta(phone, countryCode);
  return normalized ? sha256Hex(normalized) : null;
}

function hashFirstName(name) {
  if (!name || typeof name !== 'string') return null;
  const normalized = name.trim().toLowerCase();
  return normalized ? sha256Hex(normalized) : null;
}

/**
 * Build Meta Custom Audience hashed contact row per Meta spec.
 */
function hashContactRow({ phone, email, firstName, countryCode = '91' }) {
  const phoneHash = hashPhone(phone, countryCode);
  const emailHash = hashEmail(email);
  const firstNameHash = hashFirstName(firstName);
  if (!phoneHash && !emailHash) return null;
  return {
    phoneHash,
    emailHash,
    firstNameHash,
    countryCode: String(countryCode || '91'),
  };
}

function hashContactList(contacts = [], countryCode = '91') {
  const seen = new Set();
  const out = [];
  for (const c of contacts) {
    const row = hashContactRow({ ...c, countryCode: c.countryCode || countryCode });
    if (!row) continue;
    const key = `${row.phoneHash || ''}:${row.emailHash || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

module.exports = {
  normalizeEmail,
  normalizePhoneForMeta,
  sha256Hex,
  hashEmail,
  hashPhone,
  hashFirstName,
  hashContactRow,
  hashContactList,
};
