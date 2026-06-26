"use strict";

const { sanitizePhoneForStorage } = require("../utils/core/phoneE164Policy");

const INGRESS_PHONE_KEYS = new Set([
  "phone",
  "phoneNumber",
  "customerPhone",
  "shippingPhone",
  "billingPhone",
  "contactPhone",
  "whatsappPhone",
  "alternatePhone",
  "recipientPhone",
  "senderPhone",
]);

function sanitizePhoneFieldsDeep(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePhoneFieldsDeep(item, depth + 1));
  }
  if (typeof value !== "object") return value;

  const out = { ...value };
  for (const [key, val] of Object.entries(out)) {
    if (INGRESS_PHONE_KEYS.has(key) && typeof val === "string" && val.trim()) {
      const normalized = sanitizePhoneForStorage(val);
      if (normalized) out[key] = normalized;
    } else if (val && typeof val === "object") {
      out[key] = sanitizePhoneFieldsDeep(val, depth + 1);
    }
  }
  return out;
}

/**
 * Express middleware — normalize known phone keys in JSON bodies before route handlers.
 */
function phoneSanitizeIngress(req, _res, next) {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    req.body = sanitizePhoneFieldsDeep(req.body);
  }
  next();
}

module.exports = {
  phoneSanitizeIngress,
  sanitizePhoneFieldsDeep,
  INGRESS_PHONE_KEYS,
};
