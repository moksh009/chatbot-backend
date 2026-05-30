const log = require('../core/logger');
const { withShopifyRetry } = require('../shopify/shopifyHelper');
const { withTimeout } = require('../core/asyncTimeout');
const { callAIJSON, callAI } = require('../core/aiGateway');
const { AI_BOT_TIMEOUT_MS } = require('../core/gemini');
const Conversation = require('../../models/Conversation');
const Client = require('../../models/Client');

function isNegotiationAttempt(text) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  const negotiationKeywords = [
    'discount', 'coupon', 'offer', 'promo', 'cheap', 'price', 'negotiate', 'bargain', 'haggle',
    'reduce', 'less', 'best price', 'lower', 'cost', 'expensive', 'waive', 'free',
  ];
  return negotiationKeywords.some((keyword) => lowerText.includes(keyword));
}

async function detectNegotiationIntent(userText, clientId) {
  try {
    const prompt = `Analyze this customer message: "${userText}"
    Is the customer asking for a discount, better price, offer, coupon code, or trying to negotiate/haggle?
    Return a JSON object: {"isNegotiating": boolean, "aggressive": boolean}`;

    const result = await withTimeout(
      callAIJSON({ clientId, feature: 'other', prompt, maxTokens: 128, fast: true }),
      8000,
      'NegotiationIntent'
    );
    return !!result?.data?.isNegotiating;
  } catch (err) {
    log.error('Negotiation intent detection failed:', { error: err.message });
    return false;
  }
}

async function generateNegotiatedDiscount(client, percentage, flatCap, cartTotal) {
  return await withShopifyRetry(client.clientId, async (shopify) => {
    let valueType = 'percentage';
    let value = `-${percentage.toFixed(1)}`;

    if (cartTotal > 0 && flatCap > 0) {
      const discountAmount = (cartTotal * percentage) / 100;
      if (discountAmount > flatCap) {
        valueType = 'fixed_amount';
        value = `-${flatCap.toFixed(2)}`;
      }
    }

    const code = `OFFER${Math.floor(1000 + Math.random() * 9000)}`;

    const ruleRes = await shopify.post('/price_rules.json', {
      price_rule: {
        title: `AI_Haggle_${code}`,
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: valueType,
        value,
        customer_selection: 'all',
        starts_at: new Date().toISOString(),
      },
    });

    const ruleId = ruleRes.data.price_rule.id;
    await shopify.post(`/price_rules/${ruleId}/discount_codes.json`, {
      discount_code: { code },
    });

    return code;
  });
}

async function processNegotiation(client, lead, userText, convo, phone) {
  try {
    const limits = client.ai?.negotiationSettings || client.negotiationSettings;
    if (!limits || !limits.enabled) return { handled: false };

    const clientId = client.clientId;
    const isNegotiating = await detectNegotiationIntent(userText, clientId);
    if (!isNegotiating) return { handled: false };

    log.info(`[NegotiationEngine] Detected discount request from ${phone}. Resolving...`);

    const metadata = convo.metadata || {};
    const negotiationCount = (metadata.negotiationCount || 0) + 1;

    if (negotiationCount > 3) {
      return { handled: true, reply: "I've offered you our absolute rock-bottom best price, my friend! 😅 I simply can't go any lower." };
    }

    await Conversation.findByIdAndUpdate(convo._id, {
      $set: { 'metadata.negotiationCount': negotiationCount },
    });

    const min = limits.minDiscountPercent || 5;
    const max = limits.maxDiscountPercent || 15;
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

    const result = await withTimeout(
      callAIJSON({ clientId, feature: 'other', prompt, maxTokens: 512, fast: true }),
      AI_BOT_TIMEOUT_MS,
      'NegotiationReply'
    );
    const data = result?.data;
    if (!data?.replyMessage) return { handled: false };

    let finalReply = data.replyMessage;

    if (data.offerPercentage > 0 && client.storeType === 'shopify') {
      try {
        const cartTotal = lead?.cart?.totalPrice || 0;
        const code = await withTimeout(
          generateNegotiatedDiscount(client, data.offerPercentage, limits.maxDiscountAmountFlat || 1000, cartTotal),
          10000,
          'NegotiationShopifyDiscount'
        );
        finalReply += `\n\nUse this exclusive code at checkout: *${code}*`;
        await Client.findByIdAndUpdate(client._id, {
          $push: { generatedDiscounts: { code, percentage: data.offerPercentage, createdAt: new Date() } },
        });
      } catch (codeErr) {
        log.error('Failed to generate discount code during negotiation:', { error: codeErr.message });
      }
    }

    return { handled: true, reply: finalReply };
  } catch (error) {
    if (error.code === 'AI_NOT_CONFIGURED') return { handled: false };
    log.error('NegotiationEngine Error:', { error: error.message });
    return { handled: false };
  }
}

module.exports = {
  isNegotiationAttempt,
  processNegotiation,
};
