'use strict';

const { generateText } = require('../utils/core/gemini');
const { buildDocsContextForPrompt } = require('../constants/docsKnowledgeBase');

function buildMerchantContext(client = {}) {
  return {
    plan: client.plan || 'trial',
    whatsappConnected: !!(client.whatsappToken || client.config?.whatsappToken),
    shopifyConnected: !!(client.shopifyAccessToken || client.config?.shopifyAccessToken),
    instagramConnected: !!client.instagramConnected,
    shopDomain: client.shopDomain || client.config?.shopDomain || '',
  };
}

function buildSupportSystemPrompt(client) {
  const merchantConfig = buildMerchantContext(client);
  return `You are a helpful support agent for TopEdge AI, an enterprise WhatsApp automation platform for e-commerce brands.

Merchant info: ${JSON.stringify(merchantConfig)}

Your role:
- Answer questions about WhatsApp API, Meta templates, Shopify sync, campaigns, flow builder, and platform features
- Give step-by-step instructions with exact menu paths (Settings → Integrations, Meta Manager, etc.)
- If you cannot resolve the issue, say you will connect them with the team

Be concise. Use simple language. Do not invent features.

Documentation index:
${buildDocsContextForPrompt()}`;
}

async function generateSupportReply({ client, message, priorMessages = [] }) {
  const system = buildSupportSystemPrompt(client);
  const history = priorMessages
    .slice(-6)
    .map((m) => `${m.sender}: ${m.text}`)
    .join('\n');
  const prompt = `${system}\n\nConversation:\n${history}\n\nMerchant: ${message}\n\nReply:`;
  const raw = await generateText(prompt, { client });
  return String(raw || '').trim() || "I'll connect you with our team for this one.";
}

module.exports = {
  buildMerchantContext,
  buildSupportSystemPrompt,
  generateSupportReply,
};
