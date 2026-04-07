const TrainingExample = require("../models/TrainingExample");
const logger          = require("./logger");

/**
 * Find the most relevant training examples for the current message.
 * Uses keyword overlap for fast retrieval (no embeddings API needed).
 */
async function getRelevantExamples(clientId, userMessage, limit = 5) {
  try {
    // Extract keywords from user message (simple but effective)
    const stopWords = new Set(["a","an","the","is","are","was","were","i","my","me",
      "can","you","will","what","how","when","where","please","have","has",
      "hai","kya","mera","mujhe","chahiye","batao"]);
    
    const keywords = userMessage.toLowerCase()
      .split(/[\s,।?!\.]+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
    
    if (!keywords.length) return [];
    
    // Find examples that contain any of these keywords in userMessage
    const examples = await TrainingExample.find({
      clientId,
      isActive: true,
      $or: keywords.map(kw => ({
        userMessage: { $regex: kw, $options: "i" }
      }))
    })
    .sort({ useCount: -1 })
    .limit(limit * 2)
    .lean();
    
    if (examples.length === 0) return [];
    
    // Score by keyword overlap
    const scored = examples.map(ex => {
      const exWords  = ex.userMessage.toLowerCase().split(/\s+/);
      const overlap  = keywords.filter(kw => exWords.some(w => w.includes(kw))).length;
      return { ...ex, relevanceScore: overlap };
    });
    
    return scored
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  } catch (err) {
    logger.warn(`[TrainingEngine] Retrieval failed for ${clientId}:`, err.message);
    return [];
  }
}

/**
 * Build a few-shot learning section for the Gemini prompt.
 */
function buildFewShotPrompt(examples) {
  if (!examples || examples.length === 0) return "";
  
  const lines = examples.map(ex =>
    `Customer: "${ex.userMessage}"\nCorrect Answer: "${ex.agentCorrection}"`
  ).join("\n\n");
  
  return `\n\nLEARNED FROM PAST CONVERSATIONS (use these as guidance):\n${lines}\n`;
}

/**
 * Save a training example when an agent corrects the bot.
 */
async function saveTrainingExample(clientId, data) {
  const {
    userMessage, botResponse, agentCorrection,
    correctedBy, conversationId, phone
  } = data;
  
  // Auto-detect topic
  const topics = {
    return:   ["return", "refund", "exchange", "cancel", "wapas"],
    delivery: ["delivery", "shipping", "dispatch", "track", "courier", "deliver"],
    pricing:  ["price", "cost", "discount", "offer", "rate", "kitna"],
    product:  ["product", "doorbell", "camera", "feature", "specification", "spec"],
    warranty: ["warranty", "guarantee", "repair", "service"],
    payment:  ["payment", "cod", "upi", "online", "razorpay", "pay"]
  };
  
  const msgLower = userMessage.toLowerCase();
  let detectedTopic = "general";
  for (const [topic, keywords] of Object.entries(topics)) {
    if (keywords.some(kw => msgLower.includes(kw))) {
      detectedTopic = topic;
      break;
    }
  }
  
  return await TrainingExample.create({
    clientId,
    userMessage:     userMessage.substring(0, 500),
    botResponse:     botResponse.substring(0, 1000),
    agentCorrection: agentCorrection.substring(0, 1000),
    correctedBy,
    correctedAt:     new Date(),
    conversationId,
    phone,
    topic:           detectedTopic,
    useCount:        0,
    isActive:        true,
    createdAt:       new Date()
  });
}

module.exports = { getRelevantExamples, buildFewShotPrompt, saveTrainingExample };
