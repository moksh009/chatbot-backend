"use strict";

/**
 * sentimentAnalyzer.js — Phase 26 Track 4
 * Per-message sentiment scoring: keyword-based (fast) + Gemini (for ambiguous).
 * Returns: { sentiment, score, urgency, flags, method }
 */

const log = require('./logger')('SentimentAnalyzer');

/* ── Keyword bank (English, Hindi, Gujarati, Hinglish) ─────────────────── */
const KEYWORDS = {
  positive: {
    high: [
      'love', 'amazing', 'excellent', 'perfect', 'fantastic', 'great', 'awesome',
      'outstanding', 'brilliant', 'superb', 'best', 'wonderful', 'incredible',
      'bahut accha', 'bahut badiya', 'mast', 'superb', 'ekdam sahi',
      'khub saru', 'saras', 'badiya', 'shandar', 'zabardast'
    ],
    medium: [
      'good', 'nice', 'okay', 'fine', 'happy', 'thanks', 'thank you', 'ty',
      'pleased', 'satisfied', 'helpful', 'fast delivery', 'on time',
      'accha', 'theek', 'haan', 'thik hai', 'sahi', 'bilkul',
      'saru', 'maja', 'khush', 'khusi'
    ]
  },
  negative: {
    high: [
      'terrible', 'awful', 'worst', 'horrible', 'scam', 'fraud', 'cheated',
      'useless', 'disgusting', 'pathetic', 'rubbish', 'trash',
      'cancel', 'refund', 'angry', 'furious', 'very disappointed', 'never again',
      'complaint', 'legal', 'consumer court', 'chargeback',
      'bakwaas', 'bekar', 'dhoka', 'fraud hai', 'ghatiya', 'cheat',
      'khota', 'nathi chalje', 'barbar nathi', 'pagal'
    ],
    medium: [
      'bad', 'not good', 'problem', 'issue', 'delay', 'late', 'where is',
      'not working', 'broken', 'disappointed', 'missing', 'wrong item',
      'damaged', 'defective', 'poor quality', 'slow', 'never received',
      'sahi nahi', 'kharab', 'nahi aaya', 'der ho gayi', 'galat',
      'saru nathi', 'mari nathi', 'toot gaya', 'kharab chhe'
    ]
  },
  urgent: [
    'urgent', 'asap', 'immediately', 'right now', 'emergency', 'help me now',
    'critical', 'today only', 'deadline', 'can\'t wait',
    'abhi', 'jaldi', 'turant', 'important', 'zaruri',
    'haman j', 'aajej', 'tatkal'
  ]
};

/**
 * Fast keyword-based scoring. Returns score (-100 to +100) and flags.
 */
function scoreKeywords(text) {
  const lower = text.toLowerCase();
  let score = 0;
  const flags = [];

  KEYWORDS.positive.high.forEach(kw => {
    if (lower.includes(kw)) { score += 30; flags.push(`pos_high:${kw}`); }
  });
  KEYWORDS.positive.medium.forEach(kw => {
    if (lower.includes(kw)) score += 10;
  });
  KEYWORDS.negative.high.forEach(kw => {
    if (lower.includes(kw)) { score -= 35; flags.push(`neg_high:${kw}`); }
  });
  KEYWORDS.negative.medium.forEach(kw => {
    if (lower.includes(kw)) { score -= 15; }
  });
  const isUrgent = KEYWORDS.urgent.some(kw => lower.includes(kw));
  if (isUrgent) { score -= 10; flags.push('urgent'); }

  return { score: Math.max(-100, Math.min(100, score)), isUrgent, flags };
}

/**
 * Map numeric score to sentiment label.
 */
function scoreToSentiment(score) {
  if (score >=  40) return 'very_positive';
  if (score >=  15) return 'positive';
  if (score >= -15) return 'neutral';
  if (score >= -40) return 'negative';
  return 'very_negative';
}

/**
 * Main analyzer.
 * @param {string} text    - Raw message text
 * @param {Object} client  - Client document (for Gemini key)
 * @returns {Promise<{ sentiment, score, urgency, flags, method }>}
 */
async function analyzeSentiment(text, client) {
  if (!text || typeof text !== 'string' || text.length < 2) {
    return { sentiment: 'neutral', score: 0, urgency: 'low', flags: [], method: 'skip' };
  }

  const { score, isUrgent, flags } = scoreKeywords(text);
  const urgency = isUrgent ? 'high' : score <= -40 ? 'medium' : 'low';

  // If clearly positive or negative — return immediately without Gemini call
  if (score <= -21 || score >= 21 || text.length <= 30) {
    return {
      sentiment: scoreToSentiment(score),
      score,
      urgency,
      flags,
      method: 'keywords'
    };
  }

  // Ambiguous — use Gemini for better accuracy
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const apiKey = client?.geminiApiKey || client?.ai?.geminiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('No Gemini key');

    const genAI  = new GoogleGenerativeAI(apiKey);
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    const result = await model.generateContent(
      `Classify the sentiment of this WhatsApp customer message. The message may be in English, Hindi, Gujarati, or Hinglish.\n` +
      `Sentiment options: very_positive, positive, neutral, negative, very_negative\n` +
      `Urgency options: low, medium, high\n` +
      `Message: "${text.substring(0, 300)}"\n` +
      `Return ONLY valid JSON, no markdown: {"sentiment":"...","urgency":"...","score":<number -100 to 100>}`
    );
    const raw    = result.response.text().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);

    return {
      sentiment: parsed.sentiment || scoreToSentiment(score),
      score:     typeof parsed.score === 'number' ? parsed.score : score,
      urgency:   parsed.urgency || urgency,
      flags,
      method:    'gemini'
    };
  } catch {
    // Gemini failed — return keyword result
    return {
      sentiment: scoreToSentiment(score),
      score,
      urgency,
      flags,
      method: 'keywords_fallback'
    };
  }
}

module.exports = { analyzeSentiment, scoreToSentiment, KEYWORDS };
