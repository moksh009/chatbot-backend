const Order = require('../models/Order');
const Message = require('../models/Message');
const CustomerIntelligence = require('../models/CustomerIntelligence');
const AdLead = require('../models/AdLead');
const Conversation = require('../models/Conversation');
const { generateText } = require('./gemini');

/**
 * Tracks an interaction for a customer, updating peak hours and engagement score.
 */
async function trackInteraction(clientId, phone, leadId) {
  try {
    const currentHour = new Date().getHours();
    
    // Upsert DNA Document
    let dna = await CustomerIntelligence.findOne({ clientId, phone });
    if (!dna) {
      dna = new CustomerIntelligence({ clientId, phone, leadId });
    }

    // Update Peak Hours
    if (!dna.peakInteractionHours) dna.peakInteractionHours = [];
    const hourIndex = dna.peakInteractionHours.findIndex(p => p.hour === currentHour);
    if (hourIndex > -1) {
      dna.peakInteractionHours[hourIndex].interactionCount += 1;
    } else {
      dna.peakInteractionHours.push({ hour: currentHour, interactionCount: 1 });
    }

    // engagementScore bump (recency weight)
    dna.engagementScore = Math.min(100, (dna.engagementScore || 0) + 2);
    dna.churnRiskScore = Math.max(0, (dna.churnRiskScore || 0) - 5);
    dna.updatedAt = new Date();

    await dna.save();
  } catch (error) {
    console.error("Error tracking DNA:", error);
  }
}

/**
 * Performs a deep computation of the customer's behavioral DNA.
 * Aggregates order history, messaging habits, and campaign responsiveness.
 */
async function computeDNA(clientId, phone, geminiKey) {
  try {
    let dna = await CustomerIntelligence.findOne({ clientId, phone });
    if (!dna) {
      // Create skeleton if not found
      dna = new CustomerIntelligence({ clientId, phone });
    }

    const [orders, messages, lead, convo] = await Promise.all([
      Order.find({ clientId, $or: [{ phone }, { customerPhone: phone }] }).lean(),
      Message.find({ clientId, phone }).sort({ timestamp: -1 }).limit(30).lean(),
      AdLead.findOne({ clientId, phoneNumber: phone }).lean(),
      Conversation.findOne({ clientId, phone }).lean()
    ]);

    // 1. Transactional Metrics
    const totalSpent = orders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const orderCount = orders.length;
    dna.lifetimeOrders = orderCount;
    dna.lifetimeValue = totalSpent;
    dna.avgOrderValue = orderCount > 0 ? (totalSpent / orderCount) : 0;
    dna.preferredPayment = orders[0]?.paymentMethod?.toLowerCase() || 'unknown';

    // 2. Messaging Habists
    const incoming = messages.filter(m => m.direction === 'incoming');
    dna.avgMessageLength = incoming.length > 0 
      ? (incoming.reduce((sum, m) => sum + (m.content?.length || 0), 0) / incoming.length)
      : 0;
    dna.emojiUsage = incoming.length > 0
      ? (incoming.filter(m => /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(m.content)).length / incoming.length)
      : 0;

    // 3. AI Persona & Strategy
    const conversationContext = messages.slice(0, 15).reverse().map(m => `${m.direction}: ${m.content}`).join('\n');
    const prompt = `
Analyze this customer's behavior and messaging history.
Conversation History:
${conversationContext}

Metrics:
Orders: ${orderCount}
Total Spent: ${totalSpent}
Avg Message Length: ${dna.avgMessageLength}

Determine:
1. "persona": ONE OF [value_shopper, impulse_buyer, vip, window_shopper, bargain_hunter, negotiator]
2. "formality": [formal, casual]
3. "priceSensitivity": [low, medium, high]
4. "personalizationHints": [3 short bullet points for a sales agent on how to close this person]
5. "summary": One line summary.

Return ONLY JSON.
`;

    const resultText = await generateText(prompt, geminiKey, { temperature: 0.2 });
    if (resultText) {
      const result = JSON.parse(resultText.replace(/```json|```/g, '').trim());
      dna.persona = result.persona || 'unknown';
      dna.formality = result.formality || 'casual';
      dna.priceSensitivity = result.priceSensitivity || 'medium';
      dna.personalizationHints = result.personalizationHints || [];
      dna.aiSummary = result.summary || '';
    }

    dna.lastSynthesisAt = new Date();
    await dna.save();
    return dna;
  } catch (error) {
    console.error("DNA Computation error:", error);
    return null;
  }
}

/**
 * Returns a quick contextual brief for an agent about to reply to this customer.
 */
async function getPersonalizationContext(clientId, phone) {
  const dna = await CustomerIntelligence.findOne({ clientId, phone }).lean();
  
  if (!dna) {
    return {
      isVIP: false,
      toneRecommendation: "Keep it friendly and professional.",
      closingTips: ["Initiate conversation", "Assess needs"],
      churnRisk: "LOW",
      personaIcon: "👤"
    };
  }

  return {
    isVIP: dna.persona === 'vip' || dna.lifetimeValue > 5000,
    toneRecommendation: dna.formality === 'formal' ? "Be professional and clear." : "Keep it friendly and use emojis.",
    closingTips: dna.personalizationHints || [],
    churnRisk: dna.churnRiskScore > 70 ? "HIGH" : "LOW",
    personaIcon: {
      vip: "👑",
      value_shopper: "💰",
      negotiator: "🤝",
      impulse_buyer: "⚡"
    }[dna.persona] || "👤"
  };
}

module.exports = {
  trackInteraction,
  computeDNA,
  getPersonalizationContext
};
