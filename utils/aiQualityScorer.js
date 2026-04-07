const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Client = require('../models/Client');
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Phase 29: AI Quality Scorer
 * Uses Gemini to audit the last 10-15 messages of a conversation.
 */
exports.auditConversation = async (conversationId) => {
  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) return;

    const messages = await Message.find({ conversationId })
      .sort({ timestamp: -1 })
      .limit(12);

    if (messages.length < 3) return; // Not enough context to score

    const client = await Client.findOne({ clientId: conversation.clientId });
    const apiKey = client?.openaiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
    
    if (!apiKey) {
      console.warn(`[AI Quality Scorer] No API key for client ${conversation.clientId}`);
      return;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const transcript = messages.reverse().map(m => 
      `${m.direction === 'inbound' ? 'Customer' : 'Bot'}: ${m.body}`
    ).join('\n');

    const prompt = `
      You are an expert Quality Assurance Auditor for an AI Customer Support bot.
      Evaluate the following conversation transcript between a 'Customer' and a 'Bot'.
      
      CRITERIA:
      1. Helpfulness: Did the bot answer the user's questions or guide them correctly?
      2. Human-like Tone: Did the bot sound natural and professional?
      3. Goal Alignment: Did the bot attempt to assist with the business goal (e.g. sales, support, booking)?
      4. Avoidance of Repetition: Did the bot avoid getting stuck in loops?

      TRANSCRIPT:
      ${transcript}

      OUTPUT FORMAT (JSON ONLY):
      {
        "score": number (0-100),
        "feedback": "string (one concise sentence in English explaining the score)",
        "strengths": ["string"],
        "weaknesses": ["string"]
      }
    `;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    // Clean JSON if Gemini adds markdown blocks
    const cleanJson = responseText.replace(/```json|```/gi, '').trim();
    const auditData = JSON.parse(cleanJson);

    // Update conversation with audit results
    conversation.aiQualityScore = auditData.score || 0;
    conversation.aiAuditFeedback = auditData.feedback || "Audit complete.";
    conversation.lastAuditedAt = new Date();
    await conversation.save();

    console.log(`[AI Scorer] ${conversation.phone} audited with score: ${auditData.score}`);
    return auditData;

  } catch (error) {
    console.error(`[AI Quality Scorer] Error auditing ${conversationId}:`, error.message);
  }
};
