"use strict";

const { decrypt } = require("./encryption");

/** Keep in sync with utils/meta/clientWhatsAppCreds.js */
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
    if (d && !looksLikeAppEncryptedToken(d)) return d;
    return "";
  }
  return s;
}

/**
 * Gemini key stored on the merchant's Client document only.
 * Do not merge process.env.GEMINI_API_KEY here — tenant bots must not bill against the platform dashboard key.
 */
function resolveClientGeminiKey(client) {
  if (!client || typeof client !== "object") return null;
  const k =
    (client.ai && client.ai.geminiKey) ||
    client.geminiApiKey ||
    client.openaiApiKey ||
    (client.config && client.config.geminiApiKey) ||
    "";
  const plain = maybeDecryptSecret(k);
  return plain || null;
}

module.exports = { resolveClientGeminiKey, maybeDecryptSecret, looksLikeAppEncryptedToken };
