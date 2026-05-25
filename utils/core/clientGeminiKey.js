"use strict";

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
  const t = String(k).trim();
  return t || null;
}

module.exports = { resolveClientGeminiKey };
