const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Phase 29: Competitor Intelligence Engine
 * Researches a competitor URL to extract pricing and strategy.
 */
exports.researchCompetitor = async (competitorUrl) => {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  try {
    // 1. Fetch page content (simplified scraping)
    // Note: In production, use a more robust scraper like Puppeteer or a Scraper API
    const response = await axios.get(competitorUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (IntelligenceBot/1.0)' }
    }).catch(() => ({ data: "Failed to fetch content directly." }));

    const pageText = typeof response.data === 'string' ? response.data.slice(0, 15000) : "Content unreadable";

    // 2. Analyze with Gemini
    const prompt = `
      You are a competitive intelligence analyst.
      Analyze the following content from a competitor website (${competitorUrl}):
      
      --- CONTENT START ---
      ${pageText}
      --- CONTENT END ---

      Research this business and provide a report. 
      If you can't read the content, use your internal knowledge about the brand if it's well known.
      
      Return ONLY a JSON object:
      {
        "competitorName": "Name",
        "pricingStrategy": "e.g. Premium / Value / Dynamic",
        "estimatedPricing": ["Item 1: ₹X", "Item 2: ₹Y"],
        "keyStrengths": ["Strength 1", "Strength 2"],
        "weaknessesToExploit": ["Weakness 1", "Weakness 2"],
        "winRateRecommendation": "Specific strategy to beat them on WhatsApp",
        "confidenceScore": 0.0-1.0
      }
    `;

    const result = await model.generateContent(prompt);
    const aiResponse = await result.response;
    const text = aiResponse.text().replace(/```json/g, '').replace(/```/g, '').trim();
    
    return JSON.parse(text);
  } catch (error) {
    console.error("Competitor Intel Error:", error);
    throw error;
  }
};
