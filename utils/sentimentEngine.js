"use strict";

const { generateText } = require("./gemini");
const log = require("./logger")("SentimentEngine");

/**
 * AI SENTIMENT ANALYSIS ENGINE — Phase 26
 * 
 * Provides real-time emotional intelligence for incoming messages.
 * Uses a hybrid approach: Fast Keyword Matching + Gemini Deep Analysis.
 */

const URGENT_KEYWORDS = ["emergency", "urgent", "asap", "immediately", "quick", "fast", "right now", "hurry"];
const FRUSTRATED_KEYWORDS = ["bad", "worst", "terrible", "scam", "fraud", "angry", "annoyed", "stupid", "useless", "hate", "disappointed", "waiting", "too long"];
const POSITIVE_KEYWORDS = ["thanks", "thank you", "great", "awesome", "good", "happy", "love", "perfect", "amazing", "wow"];

/**
 * Analyzes the sentiment of a message.
 * 
 * @param {string} text - The message content
 * @param {Object} client - The client object (for AI keys)
 * @returns {Promise<{ sentiment: string, score: number, summary?: string }>}
 */
async function analyzeSentiment(text, client) {
  if (!text || typeof text !== "string") {
    return { sentiment: "Neutral", score: 0 };
  }

  const lowerText = text.toLowerCase();
  
  // 1. FAST KEYWORD MATCHING (Priority)
  let initialSentiment = "Neutral";
  let score = 0;

  if (URGENT_KEYWORDS.some(k => lowerText.includes(k))) {
    initialSentiment = "Urgent";
    score = -0.8;
  } else if (FRUSTRATED_KEYWORDS.some(k => lowerText.includes(k))) {
    initialSentiment = "Frustrated";
    score = -0.9;
  } else if (POSITIVE_KEYWORDS.some(k => lowerText.includes(k))) {
    initialSentiment = "Positive";
    score = 0.8;
  }

  // 2. DEEP GEMINI ANALYSIS (Only for Negative/Urgent or fallback)
  // We trigger Gemini if it's potentially negative/urgent to get a nuanced summary for the agent.
  if (initialSentiment === "Frustrated" || initialSentiment === "Urgent" || initialSentiment === "Neutral") {
    try {
      const aiKey = client.ai?.geminiKey || client.geminiApiKey || process.env.GEMINI_API_KEY;
      
      const prompt = `
        Analyze the sentiment of this customer message for a WhatsApp chatbot:
        Message: "${text}"

        Respond ONLY in JSON format:
        {
          "sentiment": "Positive" | "Neutral" | "Negative" | "Frustrated" | "Urgent",
          "score": number between -1 and 1,
          "summary": "Short 1-sentence summary of customer emotion/need"
        }
      `;

      const response = await generateText(prompt, aiKey);
      if (response) {
        try {
          // Clean the JSON response (strip markdown blocks if any)
          const cleanJson = response.replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(cleanJson);
          return {
            sentiment: parsed.sentiment || initialSentiment,
            score: parsed.score || score,
            summary: parsed.summary || ""
          };
        } catch (jsonErr) {
          log.warn("Failed to parse Gemini sentiment JSON:", jsonErr.message);
        }
      }
    } catch (err) {
      log.error("Gemini Sentiment Analysis failed:", err.message);
    }
  }

  return { sentiment: initialSentiment, score };
}

module.exports = { analyzeSentiment };
