const { generateText } = require("./gemini");

/**
 * Translates text into the target language.
 * Uses Gemini for translation and preserves intents/tone.
 *
 * @param {string} text The text to translate
 * @param {string} targetLanguage Target language (e.g. 'en', 'es', 'hi')
 * @param {string} geminiKey API Key
 * @returns {Promise<string>} Translated text
 */
async function translateText(text, targetLanguage, geminiKey) {
  if (!text || !text.trim()) return text;
  
  // Culturally aware instructions for Indian dialects
  const isDialect = ['hi', 'gu', 'mr', 'ta', 'te', 'bn', 'kn'].includes(targetLanguage.toLowerCase());
  const dialectInstruction = isDialect 
    ? `Since the target is an Indian language (${targetLanguage}), maintain the original spirit/emotional tone. If the message is informal, use standard colloquialisms (e.g., Hinglish if appropriate for 'hi').`
    : `Standard translation into ${targetLanguage}.`;

  const prompt = `
Task: Translate the text below.
Target Language: ${targetLanguage}
${dialectInstruction}

Rules:
1. Return ONLY the translated string.
2. Preserve all emojis and formatting (*bold*, _italic_).
3. Do NOT translate technical placeholders like {{variable_name}} or {{1}}.
4. Maintain the original professional/casual tone.

TEXT:
${text}
`;

  try {
    const result = await generateText(prompt, geminiKey, { temperature: 0.1, maxTokens: 800 });
    return result ? result.trim() : text;
  } catch (error) {
    console.error("Translation engine error:", error);
    return text; // Graceful fallback
  }
}

/**
 * Detects the language of a given text.
 * Optional enhancement, returns 'es', 'en', etc.
 */
async function detectLanguage(text, geminiKey) {
  if (!text || !text.trim()) return 'en';
  
  const prompt = `
Identify the dominant language of the following text.
Return ONLY the two-letter ISO 639-1 language code (e.g., 'en', 'es', 'fr', 'hi').

TEXT:
${text}
`;

  try {
    const result = await generateText(prompt, geminiKey, { temperature: 0.0, maxTokens: 10 });
    return result ? result.trim().toLowerCase().slice(0, 2) : 'en';
  } catch (error) {
    return 'en';
  }
}

module.exports = {
  translateText,
  detectLanguage
};
