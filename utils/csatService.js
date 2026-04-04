const ScheduledMessage = require('../models/ScheduledMessage');
const WhatsApp = require('./whatsapp');
const Conversation = require('../models/Conversation');
const log = require('./logger')('CSATService');

/**
 * Trigger CSAT flow for a resolved conversation
 * Schedules a native WhatsApp interactive message 1 hour after resolution
 */
async function triggerCSAT(conversation) {
  try {
    const { _id, clientId, phone, channel } = conversation;

    if (channel !== 'whatsapp') return; // Only native WhatsApp buttons for now

    const sendAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour delay

    // Schedule the CSAT survey
    await ScheduledMessage.create({
      clientId: clientId,
      phone: phone,
      channel: 'whatsapp',
      messageType: 'interactive',
      content: {
        type: 'button',
        body: { text: "Hi! 👋 We hope we resolved your issue. How would you rate your experience with our team?" },
        action: {
          buttons: [
            { type: 'reply', reply: { id: `csat_1_${_id}`, title: "⭐ Poor" } },
            { type: 'reply', reply: { id: `csat_3_${_id}`, title: "⭐⭐⭐ OK" } },
            { type: 'reply', reply: { id: `csat_5_${_id}`, title: "⭐⭐⭐⭐⭐ Great" } }
          ]
        }
      },
      sendAt: sendAt,
      status: 'pending',
      sourceType: 'cart_recovery', // Reusing this for simplicity in cron processing
      sourceId: `csat_${_id}`
    });

    log.info(`[CSAT] Scheduled survey for ${phone} in 1 hour`);
  } catch (err) {
    log.error(`[CSAT] Failed to trigger CSAT for ${conversation._id}:`, err.message);
  }
}

/**
 * Handle CSAT Response (called from dualBrainEngine.js)
 */
async function handleCSATResponse(conversationId, buttonId) {
  try {
    const rating = parseInt(buttonId.split('_')[1]); // csat_5_ID -> 5
    if (isNaN(rating)) return;

    await Conversation.findByIdAndUpdate(conversationId, {
      csatScore: {
        rating: rating,
        respondedAt: new Date()
      }
    });

    log.info(`[CSAT] Recorded rating ${rating} for convo ${conversationId}`);
    return "Thank you for your feedback! 😊";
  } catch (err) {
    console.error('[CSAT] Error saving response:', err);
  }
}

module.exports = { triggerCSAT, handleCSATResponse };
