const log = require('./logger')('LanguageEngine');

/**
 * PHASE 23: Track 7 - Multi-Language Intelligence
 * Consolidates detection and translation for interactive AI flows.
 */

async function detectLanguage(text, client) {
  if (!text || text.length < 2) return 'en';
  if (!client.geminiApiKey) return 'en';

  try {
    // 1. Quick script-based heuristics for speed
    if (/[\u0900-\u097F]/.test(text)) return 'hi'; // Hindi Devanagari
    if (/[\u0a80-\u0aff]/.test(text)) return 'gu'; // Gujarati script
    if (/[\u0600-\u06FF]/.test(text)) return 'ar'; // Arabic script

    // 2. AI-assisted detection for Latin-based languages (Hinglish, Spanish, etc.)
    const { getGeminiModel } = require('./gemini');
    const model = getGeminiModel(client.geminiApiKey);
    
    const prompt = `
      Identify the ISO-639-1 language code for the following message. 
      If it's Hindi written in Latin script, return 'hi'. 
      If Gujarati in Latin, return 'gu'.
      Otherwise return the 2-letter code (e.g., 'en', 'es', 'fr', 'pt').
      Answer ONLY the 2-letter code.
      
      Message: "${text}"
    `;

    const result = await model.generateContent(prompt);
    const langCode = result.response.text().trim().toLowerCase().slice(0, 2);
    
    const supported = ['en', 'hi', 'gu', 'es', 'fr', 'de', 'ar', 'pt', 'it', 'mr', 'ta', 'te', 'bn'];
    return supported.includes(langCode) ? langCode : 'en';
  } catch (err) {
    log.error('[Detection] AI fallback failed:', err.message);
    return 'en';
  }
}

async function translateToUserLanguage(text, langCode, client) {
  if (!text || !langCode || langCode === 'en' || text.length < 2) return text;
  if (!client.geminiApiKey) return text;

  // Don't translate very short technical strings or numbers
  if (/^[\d,.\s]+$/.test(text)) return text;

  try {
    const { getGeminiModel } = require('./gemini');
    const model = getGeminiModel(client.geminiApiKey);
    
    const prompt = `
      Translate the following message into language ISO code '${langCode}'. 
      Retain all variables like {{first_name}}, {{order_id}} as they are.
      Keep the tone natural and respectful.
      Return ONLY the translated text.

      Message: "${text}"
    `;

    const result = await model.generateContent(prompt);
    const translated = result.response.text().trim();
    
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
async function normalizeIntent(text, client) {
  if (!text || !client.geminiApiKey) return 'general';
  
  try {
    const { getGeminiModel } = require('./gemini');
    const model = getGeminiModel(client.geminiApiKey);
    
    const prompt = `
      Classify the intent of this customer message for a CRM.
      Categories: 'purchase', 'pricing', 'support', 'complaint', 'browsing', 'general'.
      Answer with ONLY the category name.

      Message: "${text}"
    `;

    const result = await model.generateContent(prompt);
    const intent = result.response.text().trim().toLowerCase();
    
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
