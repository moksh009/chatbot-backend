"use strict";

const { resolveClientGeminiKey } = require("./clientGeminiKey");
const { isKeyValid } = require("./gemini");

const AI_CALL_TIMEOUT_MS = Number(process.env.AI_CALL_TIMEOUT_MS || 5000);

/**
 * @param {'tenant'|'platform'} purpose
 * @param {object} [client]
 */
function shouldAttemptAICall(purpose, client) {
  if (purpose === "tenant") {
    const key = resolveClientGeminiKey(client);
    return !!(key && isKeyValid(key));
  }
  if (purpose === "platform") {
    const platformKey = process.env.GEMINI_API_KEY?.trim();
    const hasVertex = !!(process.env.GCP_PROJECT_ID && process.env.GCP_PROJECT_ID.trim());
    return !!(isKeyValid(platformKey) || hasVertex);
  }
  return false;
}

module.exports = {
  shouldAttemptAICall,
  AI_CALL_TIMEOUT_MS,
};
