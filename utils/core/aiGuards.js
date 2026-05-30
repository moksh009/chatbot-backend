"use strict";

const { resolveApiKeyForClient } = require('../../services/ai/aiWalletService');

const AI_CALL_TIMEOUT_MS = Number(process.env.AI_CALL_TIMEOUT_MS || 12000);

/**
 * Tenant AI is enabled when a BYO key is connected and merchant has not disabled AI support.
 * @param {'tenant'|'platform'} purpose
 * @param {object} [client]
 */
async function shouldAttemptAICallAsync(purpose, client) {
  if (purpose !== 'tenant' || !client?.clientId) return false;
  try {
    const resolved = await resolveApiKeyForClient(client.clientId);
    if (!resolved.configured) return false;
    const wallet = resolved.wallet;
    if (wallet?.aiSupportEnabled === false) return false;
    if (client.config?.aiConfig?.aiSupportEnabled === false) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/** Sync fallback — checks legacy client flags only (prefer async in hot paths). */
function shouldAttemptAICall(purpose, client) {
  if (purpose === 'tenant') {
    if (client?.config?.aiConfig?.aiSupportEnabled === false) return false;
    const gemini = client?.geminiApiKey || client?.ai?.geminiKey;
    const openai = client?.openaiApiKey || client?.ai?.openaiKey;
    return !!(gemini || openai);
  }
  if (purpose === 'platform') {
    const { isKeyValid } = require('./gemini');
    const platformKey = process.env.GEMINI_API_KEY?.trim();
    const hasVertex = !!(process.env.GCP_PROJECT_ID && process.env.GCP_PROJECT_ID.trim());
    return !!(isKeyValid(platformKey) || hasVertex);
  }
  return false;
}

module.exports = {
  shouldAttemptAICall,
  shouldAttemptAICallAsync,
  AI_CALL_TIMEOUT_MS,
};
