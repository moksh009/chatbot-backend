'use strict';

const { callAI } = require('./aiGateway');
const { retrieveKnowledge, isRagUnavailableError } = require('./ragEngine');
const log = require('./logger')('AiReplyService');

/**
 * Generates an AI reply using the merchant's Knowledge Base + optional system prompt.
 * Used by the Flow Builder "Response by AI" node.
 */
async function generateAiReply({
  client,
  phone,
  userMessage,
  systemPrompt = '',
  model = 'gpt-4o-mini',
  maxTokens,
  conversationId,
  knowledgeBase = '',
}) {
  const clientId = client.clientId || client._id;

  let knowledgeContext = '';
  try {
    const chunks = await retrieveKnowledge(clientId, userMessage, 3, { skipIfNoCorpus: true });
    if (chunks.length > 0) {
      knowledgeContext = chunks.map(c => c.text || c.content || '').filter(Boolean).join('\n\n');
    }
  } catch (err) {
    if (!isRagUnavailableError(err)) {
      log.warn(`[generateAiReply] Knowledge retrieval failed for ${clientId}: ${err.message}`);
    }
  }

  if (!knowledgeContext && knowledgeBase) {
    knowledgeContext = String(knowledgeBase).slice(0, 3000);
  }

  const systemParts = [];
  if (systemPrompt) systemParts.push(systemPrompt);
  if (knowledgeContext) {
    systemParts.push(
      `Use the following knowledge base to answer the customer's question accurately:\n\n${knowledgeContext}`
    );
  }
  systemParts.push(
    'Reply concisely and helpfully. If the answer is not in the knowledge base, say you will connect them with the team.'
  );

  const result = await callAI({
    clientId,
    feature: 'flow_ai_reply',
    prompt: `Customer message: "${userMessage}"`,
    systemPrompt: systemParts.join('\n\n'),
    maxTokens: maxTokens || 300,
    temperature: 0.5,
    model,
  });

  return result?.content || '';
}

module.exports = { generateAiReply };
