const { GoogleGenerativeAI } = require("@google/generative-ai");

function getGeminiModel(apiKey) {
  const genAI = new GoogleGenerativeAI(
    apiKey || process.env.GEMINI_API_KEY
  );
  return genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
}

async function generateText(prompt, apiKey) {
  try {
    const model  = getGeminiModel(apiKey);
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error("[Gemini] API Error:", err.message);
    throw err;
  }
}

module.exports = { getGeminiModel, generateText };
