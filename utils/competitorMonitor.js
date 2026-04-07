const axios  = require("axios");
const logger = require("./logger");
const { generateText } = require("./gemini");

/**
 * Fetch a URL and extract the price using Gemini.
 * We use Gemini to read the page — not scrapers.
 * This is less efficient but works on any website.
 */
async function fetchCompetitorPrice(product, geminiKey) {
  try {
    // Fetch the page HTML
    const { data: html } = await axios.get(product.url, {
      timeout:  15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1"
      }
    });
    
    // Extract just the text content (strip HTML more aggressively)
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .substring(0, 4000); // first 4000 chars usually has the price
    
    const prompt = `Extract the product price from this webpage text.
Return ONLY a JSON object: { "price": <number in INR>, "currency": "INR" }
If no clear price found: { "price": null }

Webpage text:
${textContent}`;
    
    const result = await generateText(prompt, geminiKey, {
      maxTokens:   50,
      temperature: 0.1
    });
    
    if (!result) return null;
    
    // Clean JSON response from Gemini
    const cleanJson = result.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleanJson);
    return parsed?.price || null;
    
  } catch (err) {
    logger.warn(`[CompetitorMonitor] Price fetch failed for ${product.url}: ${err.message}`);
    return null;
  }
}

module.exports = { fetchCompetitorPrice };
