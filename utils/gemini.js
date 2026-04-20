const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("./logger")("Gemini");

const PLATFORM_MODEL = "gemini-1.5-flash";  // High reliability
const BOT_MODEL      = "gemini-1.5-flash"; 

// Cache clients to avoid creating new instance per request
const clientCache = new Map();

function getClient(apiKey) {
  if (!apiKey) return null;
  if (!clientCache.has(apiKey)) {
    clientCache.set(apiKey, new GoogleGenerativeAI(apiKey));
  }
  return clientCache.get(apiKey);
}

/**
 * helper to validate if a string looks like a real Google AI API key.
 * Minimal check: must start with AIza and be at least 30 chars.
 */
function isKeyValid(key) {
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (trimmed.length < 30) return false;
  if (!trimmed.startsWith("AIza")) return false;
  // Common placeholders to reject
  if (trimmed.includes("ENTER_YOUR") || trimmed.includes("YOUR_API_KEY") || trimmed.includes("GEMINI_KEY")) return false;
  return true;
}

/**
 * generateText - core resilient wrapper used by BOTH purposes.
 * @param {string} prompt
 * @param {string} apiKey - client key OR platform key
 * @param {object} options - { maxTokens, temperature, timeout, maxRetries }
 * @returns {string|null} - text response or null on failure
 */
async function generateText(prompt, apiKey, options = {}) {
  const {
    maxTokens  = 1024,
    temperature = 0.7,
    timeout     = 35000,
    maxRetries  = 2
  } = options;
  
  // Decide which key to use: try provided key first (if it looks valid), else fallback to platform
  let activeKey = apiKey?.trim();
  const platformKey = process.env.GEMINI_API_KEY?.trim();

  if (!isKeyValid(activeKey)) {
    if (activeKey) {
        logger.warn(`Provided API key "${activeKey.substring(0, 8)}..." is invalid/placeholder. Falling back to platform key.`);
    }
    activeKey = platformKey;
  }

  if (!isKeyValid(activeKey)) {
    logger.error("No valid API key available (both client and platform keys are invalid or missing).");
    return null;
  }
  
  // Sanitize prompt to prevent injection attacks
  const safePrompt = String(prompt)
    .replace(/ignore (previous|all) instructions/gi, "[filtered]")
    .replace(/system prompt/gi, "[filtered]")
    .substring(0, 10000);
  
  const genAI = getClient(activeKey);
  if (!genAI) return null;
  
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const model  = genAI.getGenerativeModel({ model: PLATFORM_MODEL });
      const result = await Promise.race([
        model.generateContent(safePrompt),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Gemini timeout")), timeout)
        )
      ]);
      return result.response.text()?.trim() || null;
      
    } catch (err) {
      lastError = err;
      const msg = err.message || "";
      
      if (msg.includes("404") || msg.includes("not found")) {
        logger.error(`Model not found - check model name. Attempt ${attempt}`);
        break; // not retryable
      }
      if (msg.includes("429") || msg.includes("RATE_LIMIT") || msg.includes("quota")) {
        const waitMs = Math.pow(2, attempt) * 1000;
        logger.warn(`Rate limited. Waiting ${waitMs}ms before retry ${attempt}/${maxRetries}`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      if (msg.includes("timeout")) {
        logger.warn(`Timeout on attempt ${attempt}/${maxRetries}`);
        continue;
      }
      if (msg.includes("API_KEY_INVALID") || msg.includes("invalid")) {
        logger.error(`Invalid API key error from Google. Removing from cache.`);
        clientCache.delete(activeKey);
        
        // If we were using a client key, try falling back to platform key for next attempt if different
        if (activeKey !== platformKey && isKeyValid(platformKey)) {
            logger.info("Falling back to platform key for next retry attempt.");
            activeKey = platformKey;
            continue;
        }
        break; // not retryable if platform key also failed or was already used
      }
      logger.error(`Attempt ${attempt} failed:`, msg);
    }
  }
  
  logger.error("All retries exhausted:", lastError?.message);
  return null;
}

/**
 * generateJSON - same as generateText but strips markdown and parses JSON.
 */
async function generateJSON(prompt, apiKey, options = {}) {
  const result = await generateText(prompt, apiKey, { ...options, temperature: 0.1 });
  if (!result) return null;
  
  try {
    const clean = result
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/gi, "")
      .trim();
    return JSON.parse(clean);
  } catch (err) {
    logger.error("JSON parse failed. Original:", result.slice(0, 100));
    return null;
  }
}

/**
 * generateTextFast - Extreme performance wrapper for real-time tasks.
 * Strict 4s timeout, 0 retries. Fails to default immediately on lag.
 */
async function generateTextFast(prompt, apiKey, options = {}) {
    return generateText(prompt, apiKey, {
        ...options,
        timeout: 4000,
        maxRetries: 0,
        temperature: 0.1
    });
}

function getGeminiModel(apiKey) {
    const genAI = getClient(apiKey);
    if (!genAI) return null;
    return genAI.getGenerativeModel({ model: PLATFORM_MODEL });
}

/**
 * For PLATFORM usage (dashboard AI features).
 * Uses process.env.GEMINI_API_KEY automatically.
 */
async function platformGenerateText(prompt, options = {}) {
  return generateText(prompt, process.env.GEMINI_API_KEY, options);
}

async function platformGenerateJSON(prompt, options = {}) {
  return generateJSON(prompt, process.env.GEMINI_API_KEY, options);
}

/**
 * For BOT usage (client's WhatsApp chatbot).
 * Caller MUST pass the client's API key.
 * Returns null if client has no key (caller handles gracefully).
 */
async function botGenerateText(prompt, clientApiKey, options = {}) {
  if (!clientApiKey?.trim()) return null;
  return generateText(prompt, clientApiKey, options);
}

async function botGenerateJSON(prompt, clientApiKey, options = {}) {
  if (!clientApiKey?.trim()) return null;
  return generateJSON(prompt, clientApiKey, options);
}

module.exports = {
  getGeminiModel: getClient, // Keep getGeminiModel mapping for backward compat if anyone imports it without the new refactor
  generateText,       // low-level
  generateJSON,       // low-level
  platformGenerateText,  // dashboard features
  platformGenerateJSON,  // dashboard features
  botGenerateText,    // client's chatbot
  botGenerateJSON     // client's chatbot
};
