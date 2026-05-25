"use strict";

const { parsePhoneNumberFromString } = require("libphonenumber-js");

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

  try {
    if (raw.startsWith("+")) {
      const parsed = parsePhoneNumberFromString(raw);
      if (parsed?.isValid()) return parsed.number.replace("+", "");
    } else {
      const parsed = parsePhoneNumberFromString(raw, country);
      if (parsed?.isValid()) return parsed.number.replace("+", "");
    }
  } catch (_) {
    /* fall through */
  }

  let digits = raw.replace(/\D/g, "");
  if (!digits) return "";

  if (digits.startsWith("0") && digits.length === 11 && country === "IN") {
    digits = "91" + digits.slice(1);
  } else if (digits.length === 10 && country === "IN") {
    digits = "91" + digits;
  }

  if (digits.length >= 10 && digits.length <= 15) return digits;
  return "";
}

function normalizePhoneWithCountry(phoneRaw, client) {
  return normalizePhone(phoneRaw, resolveDefaultCountry(client));
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
  normalizePhoneWithCountry,
  resolveDefaultCountry,
  parseDateFromId,
};
