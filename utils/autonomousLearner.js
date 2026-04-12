"use strict";

const { getGeminiModel } = require('./gemini');
const Client = require('../models/Client');
const Message = require('../models/Message');
const NotificationService = require('./notificationService');
const log = require('./logger')('AutonomousLearner');

/**
 * Distills new facts from high-value conversations.
 * Facts require admin approval before entering the Knowledge Base.
 */
async function extractAndProposeKnowledge(clientId, phone, leadId) {
  try {
    const client = await Client.findOne({ clientId });
    if (!client || !client.geminiApiKey) return;

    // 1. Fetch recent messages for context (Last 20)
    const messages = await Message.find({ 
      clientId, 
      $or: [{ from: phone }, { to: phone }] 
    })
    .sort({ timestamp: -1 })
    .limit(20);

    if (messages.length < 4) return; // Not enough substance

    const transcript = messages.reverse().map(m => 
      `${m.direction === 'inbound' ? 'Customer' : 'Bot'}: ${m.body}`
    ).join('\n');

    const model = getGeminiModel(client.geminiApiKey);

    const prompt = `
      You are an Knowledge Extraction Engine for an Enterprise CRM.
      Analyze the transcript below and identify any NEW facts about the business or frequently asked questions that are NOT currently in the business profile.
      
      Look for:
      - New business policies discovered during the chat.
      - Specific product features confirmed by the human agent or bot.
      - Recurring customer pain points that need a standard answer.

      Format your response as a valid JSON array of objects:
      [{ "type": "faq"|"fact", "question_or_fact": "...", "answer": "..." }]

      If nothing new is found, return an empty array [].

      Transcript:
      ${transcript}

      JSON Response:
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\[.*\]/s);

    if (jsonMatch) {
      const candidates = JSON.parse(jsonMatch[0]);
      if (candidates.length === 0) return;

      const proposals = candidates.map(c => ({
        type: c.type || 'fact',
        content: c,
        sourceLead: leadId,
        extractedAt: new Date(),
        status: 'pending'
      }));

      // Update Client with new proposals
      await Client.findOneAndUpdate(
        { clientId },
        { $push: { pendingKnowledge: { $each: proposals } } }
      );

      // Trigger Notification for the Sidebar
      await NotificationService.createNotification(clientId, {
        type: 'alert',
        title: 'New Knowledge Distilled 🧠',
        message: `${proposals.length} new facts/FAQs were extracted from a recent high-value conversation. Review and approve them in the Knowledge Hub.`,
        priority: 'medium',
        actionUrl: '/knowledge-hub'
      });

      log.info(`Proposed ${proposals.length} knowledge items for client ${clientId}`);
    }
  } catch (err) {
    log.error('Knowledge distillation failed:', err.message);
  }
}

module.exports = { extractAndProposeKnowledge };
