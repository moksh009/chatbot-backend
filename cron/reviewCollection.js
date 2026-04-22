const cron = require('node-cron');
const ReviewRequest = require('../models/ReviewRequest');
const Client = require('../models/Client');
const Conversation = require('../models/Conversation');
const WhatsApp = require('../utils/whatsapp');
const { createMessage } = require('../utils/createMessage');

// Runs daily at 10:00 AM IST (04:30 UTC)
module.exports = function scheduleReviewCron() {
  cron.schedule("30 4 * * *", async () => {
    try {
      const { processPendingReviewRequests } = require('../utils/reputationService');
      await processPendingReviewRequests();
    } catch (err) {
      console.error("[ReviewCron] General error:", err);
    }
  });
};
