"use strict";

const { parsePhoneNumberFromString } = require("libphonenumber-js");
const { normalizeIndianPhone, indianPhoneSuffix } = require("./normalizeIndianPhone");
const { repairPhoneDigits } = require("./phoneSanitizer");

/**
 * ISO country for phone parsing — Shopify stores often use IN; override per client.
 */
function resolveDefaultCountry(client) {
  const fromClient =
    client?.defaultCountry ||
    client?.commerce?.shopify?.countryCode ||
    client?.nicheData?.defaultCountry;
  if (fromClient && String(fromClient).length === 2) {
    return String(fromClient).toUpperCase();
  }
  const env = process.env.DEFAULT_COUNTRY_CODE || "IN";
  return String(env).length === 2 ? String(env).toUpperCase() : "IN";
}

/**
 * Normalize to E.164 digits without leading + (e.g. 919876543210).
 * Returns empty string when invalid (backward compatible with legacy callers).
 */
function normalizePhone(phoneRaw, defaultCountry = "IN") {
  if (phoneRaw == null || phoneRaw === "") return "";
  const raw = String(phoneRaw).trim();
  if (!raw) return "";

  const country = String(defaultCountry || "IN").toUpperCase();
  const digitsOnly = raw.replace(/\D/g, "");

  // Corrupted concatenations — repair before libphonenumber mis-parses long digit strings
  if (country === "IN" && digitsOnly.length > 12) {
    const repaired = repairPhoneDigits(raw, country);
    return repaired || "";
  }

  // Shopify / NANP fictional test lines (555-01XX) — never treat as Indian mobiles
  if (digitsOnly.length === 10 && /^\d{3}55501\d{2}$/.test(digitsOnly)) {
    return `1${digitsOnly}`;
  }

  try {
    if (raw.startsWith("+")) {
      const parsed = parsePhoneNumberFromString(raw);
      if (parsed?.isValid()) return parsed.number.replace("+", "");
    }
  } catch (_) {
    /* fall through */
  }

  // North American numbers stored without + (1 + 10 digits)
  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) {
    try {
      const parsed = parsePhoneNumberFromString(`+${digitsOnly}`);
      if (parsed?.isValid()) return parsed.number.replace("+", "");
    } catch (_) {
      /* fall through */
    }
  }

  try {
    const parsed = parsePhoneNumberFromString(raw, country);
    if (parsed?.isValid()) return parsed.number.replace("+", "");
  } catch (_) {
    /* fall through */
  }

  if (country === "IN") {
    const e164 = normalizeIndianPhone(raw);
    if (e164) return e164.replace(/^\+/, "");
  }

  const repaired = repairPhoneDigits(raw, country);
  if (repaired) return repaired;

  let digits = digitsOnly;
  if (!digits) return "";

  if (digits.startsWith("0") && digits.length === 11 && country === "IN") {
    digits = "91" + digits.slice(1);
    const e164 = normalizeIndianPhone(digits);
    if (e164) return e164.replace(/^\+/, "");
  } else if (digits.length === 10 && country === "IN" && /^[6-9]\d{9}$/.test(digits)) {
    return "91" + digits;
  }

  if (digits.length === 11 && digits.startsWith("1")) return digits;

  return "";
}

/**
 * Human-readable phone for dashboard tables — Indian merchants see 10-digit mobiles
 * (matches Orders page); international numbers keep country formatting.
 */
function formatPhoneForDisplay(phoneRaw, defaultCountry = "IN") {
  if (phoneRaw == null || phoneRaw === "") return null;
  const raw = String(phoneRaw).trim();
  if (!raw) return null;

  const country = String(defaultCountry || "IN").toUpperCase();
  const normalized = normalizePhone(raw, country);
  if (!normalized) return null;

  const suffix = indianPhoneSuffix(normalized);

  if (normalized.length === 11 && normalized.startsWith("1")) {
    try {
      const parsed = parsePhoneNumberFromString(`+${normalized}`);
      if (parsed?.isValid()) {
        return parsed.formatInternational().replace(/\s+/g, " ").trim();
      }
    } catch (_) {
      /* fall through */
    }
  }

  if (
    (country === "IN" || normalized.startsWith("91")) &&
    normalized.length === 12 &&
    normalized.startsWith("91") &&
    /^[6-9]\d{9}$/.test(suffix)
  ) {
    return suffix;
  }

  if (country === "IN" && /^[6-9]\d{9}$/.test(suffix) && normalized.length <= 12) {
    return suffix;
  }

  if (normalized.startsWith("91") && /^[6-9]\d{9}$/.test(suffix)) {
    return suffix;
  }

  if (normalized.length === 11 && normalized.startsWith("1")) {
    try {
      const parsed = parsePhoneNumberFromString(`+${normalized}`);
      if (parsed?.isValid()) {
        return parsed.formatInternational().replace(/\s+/g, " ").trim();
      }
    } catch (_) {
      /* fall through */
    }
    return `+1 ${normalized.slice(1, 4)} ${normalized.slice(4, 7)} ${normalized.slice(7)}`;
  }

  try {
    const parsed = parsePhoneNumberFromString(`+${normalized}`);
    if (parsed?.isValid()) {
      return parsed.formatInternational().replace(/\s+/g, " ").trim();
    }
  } catch (_) {
    /* fall through */
  }

  return null;
}

function normalizePhoneWithCountry(phoneRaw, client) {
  return normalizePhone(phoneRaw, resolveDefaultCountry(client));
}

/**
 * E.164 storage format with leading + (e.g. +919876543210).
 * Use for database persistence and external API payloads.
 */
function normalizePhoneE164(phoneRaw, defaultCountry = "IN") {
  const { sanitizePhoneForStorage } = require("./phoneE164Policy");
  return sanitizePhoneForStorage(phoneRaw, defaultCountry);
}

function parseDateFromId(id, prefix) {
  const datePart = id.replace(prefix, "");
  const day = datePart.slice(0, 2);
  const month = datePart.slice(2, 4);
  const year = datePart.slice(4);
  return `${year}-${month}-${day}`;
}

module.exports = {
  normalizePhone,
  normalizePhoneE164,
  normalizePhoneWithCountry,
  formatPhoneForDisplay,
  resolveDefaultCountry,
  parseDateFromId,
};
