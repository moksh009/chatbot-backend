const { GoogleGenerativeAI } = require("@google/generative-ai");

function getGeminiModel(apiKey) {
  const genAI = new GoogleGenerativeAI(
    apiKey || process.env.GEMINI_API_KEY
  );
  // Using gemini-1.5-flash for stable production performance
  return genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
}

async function generateText(prompt, apiKey, retries = 1) {
  try {
    const model  = getGeminiModel(apiKey);
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    if (err.message?.includes("429") && retries > 0) {
      console.warn("[Gemini] Rate limited (429). Retrying in 2s...");
      await new Promise(r => setTimeout(r, 2000));
      return generateText(prompt, apiKey, retries - 1);
    }
    console.error("[Gemini] API Error:", err.message);
    return null; // caller must handle null
  }
}

module.exports = { getGeminiModel, generateText };
