"use strict";

const { decrypt } = require("./encryption");

/** Heuristic: values encrypted by utils/encryption.js look like `<32 hex iv>:<hex ciphertext>`. */
function looksLikeAppEncryptedToken(val) {
  if (typeof val !== "string" || !val.includes(":")) return false;
  const [ivHex, dataHex] = val.split(":");
  return (
    ivHex &&
    ivHex.length === 32 &&
    /^[0-9a-f]+$/i.test(ivHex) &&
    dataHex &&
    /^[0-9a-f]+$/i.test(dataHex)
  );
}

function maybeDecryptSecret(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (!s) return "";
  if (looksLikeAppEncryptedToken(s)) {
    const d = decrypt(s);
    return d && !looksLikeAppEncryptedToken(d) ? d : d || s;
  }
  return s;
}

/**
 * Bearer token for Graph API: premium (decrypted) → root whatsappToken → nested whatsapp.accessToken.
 */
function getEffectiveWhatsAppAccessToken(client) {
  if (!client) return "";
  const premium = maybeDecryptSecret(client.premiumAccessToken);
  if (premium) return premium;
  const root = maybeDecryptSecret(client.whatsappToken);
  if (root) return root;
  return maybeDecryptSecret(client.whatsapp?.accessToken);
}

/**
 * Phone number ID for /v21.0/{id}/messages — same precedence as legacy sends, plus nested whatsapp.
 */
function getEffectiveWhatsAppPhoneNumberId(client) {
  if (!client) return "";
  return (
    String(client.premiumPhoneId || "").trim() ||
    String(client.phoneNumberId || "").trim() ||
    String(client.whatsapp?.phoneNumberId || "").trim() ||
    ""
  );
}

/**
 * Mongo filter for inbound webhook routing when Meta sends metadata.phone_number_id.
 */
function phoneNumberIdMatchFilter(phoneNumberId) {
  const pid = String(phoneNumberId || "").trim();
  if (!pid) return null;
  return {
    $or: [
      { phoneNumberId: pid },
      { "whatsapp.phoneNumberId": pid },
      { "wabaAccounts.phoneNumberId": pid },
      { "config.phoneNumberId": pid },
    ],
  };
}

module.exports = {
  maybeDecryptSecret,
  getEffectiveWhatsAppAccessToken,
  getEffectiveWhatsAppPhoneNumberId,
  phoneNumberIdMatchFilter,
};
