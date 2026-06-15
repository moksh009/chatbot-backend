'use strict';

const { callAI } = require('../utils/core/aiGateway');

const FAQ_CHIPS = [
  { id: 'shipping', label: 'Shipping & delivery', reply: 'We ship across India. Most orders arrive in 3–7 business days. You will get tracking on WhatsApp or email once your order ships.' },
  { id: 'returns', label: 'Returns & exchanges', reply: 'If something is not right, reach out within the return window from your order confirmation. Share your order ID and we will help with a return or exchange.' },
  { id: 'order', label: 'Track my order', reply: 'Share your order number and the phone used at checkout — we will look up the latest status for you.' },
];

function buildWidgetSystemPrompt(client, branding) {
  const name = branding.businessName || 'the store';
  const desc = client.platformVars?.businessDescription || client.brand?.description || '';
  return `You are the friendly website assistant for ${name}, an Indian D2C e-commerce brand.
Answer in 2–4 short sentences. Be warm, clear, and practical.
Help with products, sizing, orders, shipping, COD, returns, and store policies.
If you do not know something specific (exact order status, inventory), ask for the order ID or suggest the customer leave their WhatsApp number.
Never invent tracking links, prices, or policies.${desc ? `\nStore context: ${desc.slice(0, 400)}` : ''}`;
}

async function generateWebsiteWidgetReply({ client, branding, message, history = [] }) {
  const systemPrompt = buildWidgetSystemPrompt(client, branding);
  const lines = history
    .slice(-8)
    .map((h) => `${h.role === 'assistant' ? 'assistant' : 'user'}: ${h.content}`)
    .join('\n');
  const prompt = lines ? `${lines}\nuser: ${message}\nassistant:` : `user: ${message}\nassistant:`;

  const result = await callAI({
    clientId: client.clientId,
    feature: 'website_widget',
    prompt,
    systemPrompt,
    maxTokens: 320,
    temperature: 0.45,
    fast: true,
  });

  return String(result.content || '').trim();
}

module.exports = {
  FAQ_CHIPS,
  generateWebsiteWidgetReply,
};
