const { GoogleGenerativeAI } = require('@google/generative-ai');
const log = require('./logger');
const { withShopifyRetry } = require('./shopifyHelper');
const { sendWhatsAppText } = require('./dualBrainEngine'); // Re-using to send raw text if needed, wait, better let dualBrainEngine handle sending if we return true text.
const Conversation = require('../models/Conversation');
const Client = require('../models/Client');

/**
 * Evaluates whether the user's message is a negotiation/discount request
 */
async function detectNegotiationIntent(userText, apiKey) {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', generationConfig: { responseMimeType: "application/json" } });
    
    const prompt = `Analyze this customer message: "${userText}"
    Is the customer asking for a discount, better price, offer, coupon code, or trying to negotiate/haggle?
    Return a JSON object: {"isNegotiating": boolean, "aggressive": boolean}`;

    const result = await model.generateContent(prompt);
    const data = JSON.parse(result.response.text().trim());
    return data.isNegotiating;
  } catch (err) {
    log.error('Negotiation intent detection failed:', { error: err.message });
    return false;
  }
}

/**
 * Creates the discount code in Shopify
 */
async function generateNegotiatedDiscount(client, percentage, flatCap, cartTotal) {
  return await withShopifyRetry(client.clientId, async (shopify) => {
    let valueType = "percentage";
    let value = `-${percentage.toFixed(1)}`;
    
    // If we have a cart total, we can convert to fixed amount to respect cap
    if (cartTotal > 0 && flatCap > 0) {
      const discountAmount = (cartTotal * percentage) / 100;
      if (discountAmount > flatCap) {
         valueType = "fixed_amount";
         value = `-${flatCap.toFixed(2)}`;
      }
    } else if (flatCap > 0) {
       // If no cart total is known, creating a fixed amount cap is trickier with percentage in Shopify REST.
       // We'll stick to percentage but this is a known limitation unless we use GraphQL limits.
    }

    const code = `OFFER${Math.floor(1000 + Math.random() * 9000)}`;
    
    const ruleRes = await shopify.post('/price_rules.json', {
      price_rule: {
        title: `AI_Haggle_${code}`,
        target_type: "line_item",
        target_selection: "all",
        allocation_method: "across",
        value_type: valueType,
        value: value,
        customer_selection: "all",
        starts_at: new Date().toISOString()
      }
    });

    const ruleId = ruleRes.data.price_rule.id;
    await shopify.post(`/price_rules/${ruleId}/discount_codes.json`, {
      discount_code: { code }
    });

    return code;
  });
}

/**
 * Handle AI Price Negotiation
 * Returns { handled: boolean, reply: string }
 */
async function processNegotiation(client, convo, phone, userText, lead) {
  try {
    const limits = client.ai?.negotiationSettings || client.negotiationSettings;
    if (!limits || !limits.enabled) return { handled: false };

    const apiKey = client.ai?.geminiKey || client.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) return { handled: false };

    const isNegotiating = await detectNegotiationIntent(userText, apiKey);
    if (!isNegotiating) return { handled: false };

    log.info(`[NegotiationEngine] Detected discount request from ${phone}. Resolving...`);

    // We keep track of how many times they asked in metadata
    const metadata = convo.metadata || {};
    const negotiationCount = (metadata.negotiationCount || 0) + 1;
    
    // Max 3 rounds of haggling to prevent infinite loops
    if (negotiationCount > 3) {
      return { handled: true, reply: "I've offered you our absolute rock-bottom best price, my friend! 😅 I simply can't go any lower." };
    }
    
    await Conversation.findByIdAndUpdate(convo._id, {
      $set: { 'metadata.negotiationCount': negotiationCount }
    });

    // Invoke Gemini to generate reply and offer
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', generationConfig: { responseMimeType: "application/json" } });

    const min = limits.minDiscountPercent || 5;
    const max = limits.maxDiscountPercent || 15;
    
    // Incrementally offer more based on haggle rounds
    let allowedOffer = min + (negotiationCount - 1) * ((max - min) / 2);
    if (allowedOffer > max) allowedOffer = max;

    const prompt = `You are a dynamic salesperson for ${client.businessName}. The customer said: "${userText}".
    They are negotiating or asking for a discount. 
    You are allowed to offer up to ${allowedOffer}% discount in this round.
    
    Act empathetic but firm. Make a strong offer. 
    Return a JSON object:
    {
       "offerPercentage": (number, 0 if you decide not to offer one, otherwise between ${min} and ${allowedOffer}),
       "replyMessage": (string, what the bot should say to the user. MUST mention the offer. Use friendly emojis)
    }`;

    const result = await model.generateContent(prompt);
    const data = JSON.parse(result.response.text().trim());

    let finalReply = data.replyMessage;

    // Generate actual shopify code if an offer was made
    if (data.offerPercentage > 0 && client.storeType === 'shopify') {
       try {
          const cartTotal = lead?.cart?.totalPrice || 0;
          const code = await generateNegotiatedDiscount(client, data.offerPercentage, limits.maxDiscountAmountFlat || 1000, cartTotal);
          
          finalReply += `\n\nUse this exclusive code at checkout: *${code}*`;
          
          await Client.findByIdAndUpdate(client._id, {
             $push: { generatedDiscounts: { code, percentage: data.offerPercentage, createdAt: new Date() } }
          });
       } catch (codeErr) {
          log.error('Failed to generate discount code during negotiation:', { error: codeErr.message });
       }
    }

    return { handled: true, reply: finalReply };
  } catch (error) {
    log.error('NegotiationEngine Error:', { error: error.message });
    return { handled: false };
  }
}

module.exports = {
  processNegotiation
};
