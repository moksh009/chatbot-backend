const mongoose = require('mongoose');
const { generateText } = require("./gemini");
const logger           = require("./logger");
const Conversation     = require("../models/Conversation");
const Message          = require("../models/Message");
const AdLead           = require("../models/AdLead");
const Order            = require("../models/Order");
const Client           = require("../models/Client");

async function scoreConversation(conversationId, clientId) {
  try {
    const convo = await Conversation.findById(conversationId).lean();
    if (!convo) return null;
    
    const messages = await Message.find({ conversationId })
      .sort({ timestamp: 1 }).lean();
    
    if (messages.length < 2) return null; // too few messages to score
    
    const lead   = await AdLead.findOne({ phoneNumber: convo.phone, clientId }).lean();
    const orders = await Order.find({
      customerPhone: convo.phone,
      clientId,
      createdAt: { $gte: convo.createdAt }
    }).lean();
    
    // ── DIMENSION 1: RESOLUTION (0-30 pts) ───────────────────────────
    let resolution = 0;
    let resolutionReason = "";
    
    if (orders.length > 0) {
      resolution       = 30;
      resolutionReason = "Order placed during conversation";
    } else if (convo.status === "resolved") {
      resolution       = 20;
      resolutionReason = "Conversation marked resolved";
    } else if (convo.escalationReason && (convo.botPaused || convo.handoffMode === 'MANUAL')) {
      resolution       = 15;
      resolutionReason = "Appropriately escalated to human";
    } else if (convo.status === "HUMAN_TAKEOVER") {
      resolution       = 10;
      resolutionReason = "Human took over — resolution unclear";
    } else {
      resolution       = 0;
      resolutionReason = "No resolution detected";
    }
    
    // ── DIMENSION 2: ENGAGEMENT (0-25 pts) ───────────────────────────
    const inboundCount  = messages.filter(m => m.direction === "incoming").length;
    
    let engagement = 0;
    if (inboundCount >= 5)     engagement = 25;
    else if (inboundCount >= 3) engagement = 15;
    else if (inboundCount >= 2) engagement = 10;
    else                        engagement = 5;
    
    // ── DIMENSION 3: SPEED (0-20 pts) ────────────────────────────────
    let speed = 20; // assume good unless we find evidence otherwise
    
    if (convo.firstResponseTime) {
      const firstRespMin = convo.firstResponseTime / 60000;
      if (firstRespMin > 30) speed = 0;
      else if (firstRespMin > 10) speed = 10;
      else if (firstRespMin > 2) speed = 15;
      else speed = 20;
    }
    
    // ── DIMENSION 4: SENTIMENT JOURNEY (0-15 pts) ───────────────────
    const sentimentHistory = convo.sentimentHistory || [];
    let sentimentScore = 10; // neutral default
    
    if (sentimentHistory.length >= 2) {
      const firstScore = sentimentHistory[0]?.score || 0;
      const lastScore  = sentimentHistory[sentimentHistory.length - 1]?.score || 0;
      
      if (lastScore > 20)              sentimentScore = 15; // ended positive
      else if (lastScore > 0)          sentimentScore = 12; // ended okay
      else if (firstScore < 0 && lastScore > firstScore) sentimentScore = 10; // improved
      else if (lastScore < -20)        sentimentScore = 0;  // ended frustrated
      else                             sentimentScore = 8;
    }
    
    // ── DIMENSION 5: BUSINESS OUTCOME (0-10 pts) ────────────────────
    let outcome     = 0;
    const prevScore = lead?.leadScore || 0;
    
    if (orders.length > 0 && orders[0].paymentMethod !== "cod") outcome = 10;
    else if (orders.length > 0) outcome = 8;
    else if (lead?.cartStatus === "cart_added") outcome = 5;
    else if (lead?.leadScore > 70) outcome = 5;
    
    // ── CALCULATE TOTAL ───────────────────────────────────
    const totalScore = resolution + engagement + speed + sentimentScore + outcome;
    
    const grade = totalScore >= 85 ? "A"
                : totalScore >= 70 ? "B"
                : totalScore >= 55 ? "C"
                : totalScore >= 40 ? "D"
                :                    "F";
    
    // ── AI QUALITATIVE ASSESSMENT ─────────────────────────
    let aiInsight = null;
    if (totalScore < 60) {
      const msgPreview = messages.slice(0, 10)
        .map(m => `${m.direction === "incoming" ? "Customer" : "Bot"}: ${(m.text?.body || "").substring(0, 80)}`)
        .join("\n");
      
      const insightPrompt = `
A WhatsApp bot conversation scored ${totalScore}/100. Here are the key stats:
  Resolution: ${resolution}/30 — ${resolutionReason}
  Engagement: ${engagement}/25
  Outcome: ${outcome}/10
  Final sentiment: ${convo.currentSentiment}

Conversation preview:
${msgPreview}

In ONE sentence (max 20 words), what was the main failure and how to fix it?
Return only the sentence, nothing else.`;
      
      const client = await Client.findById(clientId).select("ai").lean();
      aiInsight = await generateText(insightPrompt, client?.ai?.geminiKey, {
        maxTokens:   60,
        temperature: 0.3
      });
    }
    
    // ── SAVE QUALITY SCORE ────────────────────────────────
    const qualityData = {
      totalScore,
      grade,
      dimensions: {
        resolution:  { score: resolution,     maxScore: 30, reason: resolutionReason },
        engagement:  { score: engagement,     maxScore: 25, messageCount: inboundCount },
        speed:       { score: speed,          maxScore: 20 },
        sentiment:   { score: sentimentScore, maxScore: 15 },
        outcome:     { score: outcome,        maxScore: 10 }
      },
      aiInsight: aiInsight?.trim(),
      scoredAt: new Date()
    };
    
    await Conversation.findByIdAndUpdate(conversationId, {
      $set: { qualityScore: qualityData }
    });
    
    // ── UPDATE AGGREGATE METRICS ─────────────────────────
    await Client.findByIdAndUpdate(clientId, {
      $inc: { "qualityMetrics.totalScored": 1, [`qualityMetrics.grade${grade}`]: 1 }
    });
    
    return qualityData;
  } catch (err) {
    logger.error(`[QualityScorer] Error scoring ${conversationId}:`, err.message);
    return null;
  }
}

module.exports = { scoreConversation };
