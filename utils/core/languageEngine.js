const log = require('./logger')('LanguageEngine');
const { generateTextFast } = require('./gemini');
const { resolveClientGeminiKey } = require('./clientGeminiKey');

/**
 * PHASE 23: Track 7 - Multi-Language Intelligence
 * Consolidates detection and translation for interactive AI flows.
 */

/** Accepts a raw API key string or a Client-like object; never uses platform env keys. */
function asTenantGeminiKey(clientOrKey) {
  if (clientOrKey == null) return null;
  if (typeof clientOrKey === 'string') {
    const t = clientOrKey.trim();
    return t || null;
  }
  return resolveClientGeminiKey(clientOrKey);
}

async function detectLanguage(text, clientOrKey) {
  if (!text || text.length < 2) return 'en';
  const apiKey = asTenantGeminiKey(clientOrKey);
  if (!apiKey) return 'en';

  try {
    // 1. Quick script-based heuristics for speed
    if (/[\u0900-\u097F]/.test(text)) return 'hi'; // Hindi Devanagari
    if (/[\u0a80-\u0aff]/.test(text)) return 'gu'; // Gujarati script
    if (/[\u0600-\u06FF]/.test(text)) return 'ar'; // Arabic script

    // 2. AI-assisted detection for Latin-based languages (Hinglish, Spanish, etc.)
    const prompt = `
      Identify the ISO-639-1 language code for the following message. 
      If it's Hindi written in Latin script, return 'hi'. 
      If Gujarati in Latin, return 'gu'.
      Otherwise return the 2-letter code (e.g., 'en', 'es', 'fr', 'pt').
      Answer ONLY the 2-letter code.
      
      Message: "${text}"
    `;

    const langCodeRaw = await generateTextFast(prompt, apiKey, { noEnvFallback: true });
    const langCode = (langCodeRaw || 'en').trim().toLowerCase().slice(0, 2);
    
    const supported = ['en', 'hi', 'gu', 'es', 'fr', 'de', 'ar', 'pt', 'it', 'mr', 'ta', 'te', 'bn'];
    return supported.includes(langCode) ? langCode : 'en';
  } catch (err) {
    log.error('[Detection] AI fallback failed:', err.message);
    return 'en';
  }
}

async function translateToUserLanguage(text, langCode, clientOrKey) {
  if (!text || !langCode || langCode === 'en' || text.length < 2) return text;
  const apiKey = asTenantGeminiKey(clientOrKey);
  if (!apiKey) return text;

  // Don't translate very short technical strings or numbers
  if (/^[\d,.\s]+$/.test(text)) return text;

  try {
    const prompt = `
      Translate the following message into language ISO code '${langCode}'. 
      Retain all variables like {{first_name}}, {{order_id}} as they are.
      Keep the tone natural and respectful.
      Return ONLY the translated text.

      Message: "${text}"
    `;

    const translated = await generateTextFast(prompt, apiKey, {
      timeout: 6000,
      noEnvFallback: true,
    }); // Slightly more for translation
    return translated || text;
  } catch (err) {
    log.error('[Translation] Error:', err.message);
    return text;
  }
}

/**
 * Legacy support for AI system prompts
 */
function getLanguageInstructions(language) {
  const instructions = {
    'hi': 'The user is speaking Hindi. Respond in natural Hindi.',
    'gu': 'The user is speaking Gujarati. Respond in natural Gujarati.',
    'es': 'The user is speaking Spanish. Respond in professional Spanish.',
    'ar': 'The user is speaking Arabic. Respond in polite Arabic.',
    'en': 'The user is speaking English. Respond in professional English.'
  };
  return instructions[language] || `The user's language code is ${language}. Respond in that language.`;
}

/**
 * Phase 3: NLP Intent Normalizer
 * Simplifies raw AI intent descriptions into standardized CRM triggers.
 */
async function normalizeIntent(text, clientOrKey) {
  const apiKey = asTenantGeminiKey(clientOrKey);
  if (!text || !apiKey) return 'general';
  
  try {
    const prompt = `
      Classify the intent of this customer message for a CRM.
      Categories: 'purchase', 'pricing', 'support', 'complaint', 'browsing', 'general'.
      Answer with ONLY the category name.

      Message: "${text}"
    `;

    const intentRaw = await generateTextFast(prompt, apiKey, { noEnvFallback: true });
    const intent = (intentRaw || 'general').trim().toLowerCase();
    
    const allowed = ['purchase', 'pricing', 'support', 'complaint', 'browsing', 'general'];
    return allowed.includes(intent) ? intent : 'general';
  } catch (err) {
    return 'general';
  }
}

module.exports = { 
  detectLanguage, 
  translateToUserLanguage,
  normalizeIntent,
  getLanguageInstructions 
};
