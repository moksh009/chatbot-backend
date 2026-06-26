"use strict";

/**
 * Canonical E.164 storage policy: +{countryCode}{localDigits} with no spaces or punctuation.
 * Example: +919876543210
 *
 * Storage / DB / API persistence: sanitizePhoneForStorage() → "+CC…"
 * Meta WhatsApp Graph `to` field: normalizePhone() digits-only (no +) — never persist that form.
 */

const { normalizePhone } = require("./helpers");

/** Strip display formatting — spaces, tabs, dashes, slashes, brackets, dots. */
function stripPhoneFormatting(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/[\s\t\-/()[\].]/g, "");
}

/**
 * Sanitize any inbound phone for database storage and external API calls.
 * Returns empty string when the number cannot be normalized.
 *
 * @param {string} raw
 * @param {string} [defaultCountry='IN']
 * @returns {string} E.164 with leading + or ""
 */
function sanitizePhoneForStorage(raw, defaultCountry = "IN") {
  if (raw == null || raw === "") return "";
  const stripped = stripPhoneFormatting(raw);
  if (!stripped) return "";

  const withPlus = stripped.startsWith("+") ? stripped : `+${stripped.replace(/^\+/, "")}`;
  const digits = normalizePhone(withPlus, defaultCountry);
  if (!digits) return "";
  return `+${digits}`;
}

/**
 * Variants for DB/API lookups during migration (E.164 + legacy digit-only).
 */
function phoneStorageLookupVariants(raw, defaultCountry = "IN") {
  const e164 = sanitizePhoneForStorage(raw, defaultCountry);
  if (!e164) return [];
  const digits = e164.slice(1);
  const last10 = digits.slice(-10);
  const variants = new Set([e164, digits, `+${digits}`]);
  if (last10 && digits.length > 10) variants.add(last10);
  if (last10.length === 10) {
    variants.add(`+91${last10}`);
    variants.add(`91${last10}`);
  }
  return [...variants].filter(Boolean);
}

/** Field names that hold E.164 phones — never Meta phone_number_id values. */
const PHONE_FIELD_NAMES = new Set([
  "phone",
  "phonenumber",
  "customerphone",
  "shippingphone",
  "billingphone",
  "contactphone",
  "whatsappphone",
  "alternatephone",
  "adminphone",
  "businessphone",
  "storephone",
  "recipientphone",
  "senderphone",
  "from",
  "to",
]);

const PHONE_FIELD_EXCLUDE = new Set([
  "phonenumberid",
  "phoneid",
  "wabaid",
  "displayphonenumber",
  "verifiedphonenumber",
  "phonehash",
  "phonepemerchantid",
  "phonepesaltkey",
  "phonepesaltindex",
]);

function isPhoneSchemaPath(pathName) {
  const key = String(pathName || "").toLowerCase();
  if (PHONE_FIELD_EXCLUDE.has(key)) return false;
  if (key.startsWith("phonepe")) return false;
  if (PHONE_FIELD_NAMES.has(key)) return true;
  if (key.endsWith("phone") && !key.endsWith("phoneid")) return true;
  return false;
}

/** Nested object keys that may contain a phone sub-field. */
const NESTED_PHONE_OBJECT_KEYS = new Set([
  "shippingaddress",
  "billingaddress",
  "contact",
]);

/**
 * Sanitize known phone keys on a plain object (order addresses, webhook payloads).
 */
function sanitizePhoneFieldsInObject(obj, defaultCountry = "IN", depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizePhoneFieldsInObject(item, defaultCountry, depth + 1));
  }

  const out = { ...obj };
  for (const [key, val] of Object.entries(out)) {
    const lower = key.toLowerCase();
    if (isPhoneSchemaPath(lower) && typeof val === "string" && val.trim()) {
      const normalized = sanitizePhoneForStorage(val, defaultCountry);
      if (normalized) out[key] = normalized;
    } else if (
      val &&
      typeof val === "object" &&
      (NESTED_PHONE_OBJECT_KEYS.has(lower) || lower.endsWith("address"))
    ) {
      out[key] = sanitizePhoneFieldsInObject(val, defaultCountry, depth + 1);
    }
  }
  return out;
}

/**
 * Sanitize phone fields inside a Mongo update document ($set, $setOnInsert, top-level).
 */
function sanitizePhoneFieldsInUpdate(update, phonePaths, defaultCountry = "IN") {
  if (!update || typeof update !== "object") return update;
  const out = { ...update };
  const pathSet = new Set(phonePaths);

  const touchPath = (container, path, val) => {
    if (val == null || val === "" || typeof val !== "string") return;
    const normalized = sanitizePhoneForStorage(val, defaultCountry);
    if (normalized) container[path] = normalized;
  };

  for (const path of pathSet) {
    if (Object.prototype.hasOwnProperty.call(out, path)) {
      touchPath(out, path, out[path]);
    }
  }

  for (const op of ["$set", "$setOnInsert"]) {
    if (!out[op] || typeof out[op] !== "object") continue;
    const bucket = { ...out[op] };
    let touched = false;
    for (const path of pathSet) {
      if (Object.prototype.hasOwnProperty.call(bucket, path)) {
        const before = bucket[path];
        touchPath(bucket, path, before);
        if (bucket[path] !== before) touched = true;
      }
    }
    if (touched) out[op] = bucket;
  }

  return out;
}

module.exports = {
  stripPhoneFormatting,
  sanitizePhoneForStorage,
  phoneStorageLookupVariants,
  sanitizePhoneFieldsInObject,
  sanitizePhoneFieldsInUpdate,
  isPhoneSchemaPath,
  PHONE_FIELD_NAMES,
  PHONE_FIELD_EXCLUDE,
};
