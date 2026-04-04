const log = require('./logger');

/**
 * PHASE 23: Track 7 - Multi-Language Intelligence
 */

async function detectLanguage(text, client) {
  if (!text || text.length < 3) return 'en'; // Default or too short to detect accurately
  if (!client.geminiApiKey) return 'en';

  try {
    const { getGeminiModel } = require('./gemini');
    const model = getGeminiModel(client.geminiApiKey);
    
    const prompt = `
      Identify the ISO-639-1 language code for the following message. 
      Answer ONLY the 2-letter code (e.g., 'en', 'hi', 'es', 'ar').
      
      Message: "${text}"
    `;

    const result = await model.generateContent(prompt);
    const langCode = result.response.text().trim().toLowerCase().slice(0, 2);
    
    log.info(`[Language] Detected: ${langCode} for message: "${text.substring(0, 20)}..."`);
    return ['en', 'hi', 'es', 'fr', 'de', 'ar', 'pt', 'it'].includes(langCode) ? langCode : 'en';
  } catch (err) {
    log.error('[Language] Detection Error:', err.message);
    return 'en';
  }
}

async function translateToUserLanguage(text, langCode, client) {
  if (!text || !langCode || langCode === 'en') return text;
  if (!client.geminiApiKey) return text;

  try {
    const { getGeminiModel } = require('./gemini');
    const model = getGeminiModel(client.geminiApiKey);
    
    const prompt = `
      Translate the following message into language code '${langCode}'. 
      Retain all variables like {{first_name}} or {{product_name}} exactly as they are.
      Return ONLY the translated text.

      Message: "${text}"
    `;

    const result = await model.generateContent(prompt);
    const translated = result.response.text().trim();
    
    log.info(`[Language] Translated to ${langCode}: "${translated.substring(0, 20)}..."`);
    return translated || text;
  } catch (err) {
    log.error('[Language] Translation Error:', err.message);
    return text;
  }
}

module.exports = {
  detectLanguage,
  translateToUserLanguage
};
