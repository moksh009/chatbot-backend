const cron = require('node-cron');
const Conversation = require('../models/Conversation');
const ConversationAssignment = require('../models/ConversationAssignment');

const AUTO_RESOLVE_HOURS = 24;

// Run every hour
cron.schedule('0 * * * *', async () => {
  console.log('[AutoResolutionCron] Running stale conversation resolution check...');
  try {
    const cutoffDate = new Date(Date.now() - AUTO_RESOLVE_HOURS * 60 * 60 * 1000);

    // Find active conversations (not closed, not opted out, not resolved)
    // where the last interaction was older than the cutoff date.
    const staleConversations = await Conversation.find({
      status: { $in: ['BOT_ACTIVE', 'HUMAN_SUPPORT', 'HUMAN_TAKEOVER', 'WAITING_FOR_INPUT'] },
      lastInteraction: { $lt: cutoffDate },
      resolvedAt: { $exists: false }
    }).lean();

    if (staleConversations.length === 0) {
      console.log('[AutoResolutionCron] No stale conversations found.');
      return;
    }

    console.log(`[AutoResolutionCron] Found ${staleConversations.length} stale conversations. Auto-resolving...`);

    let resolvedCount = 0;
    for (const conv of staleConversations) {
      try {
        await Conversation.updateOne(
          { _id: conv._id },
          { 
            $set: { 
              status: 'CLOSED', 
              resolvedAt: new Date() 
            } 
          }
        );
        resolvedCount++;
      } catch (err) {
        console.error(`[AutoResolutionCron] Error updating conversation ${conv._id}:`, err.message);
      }
    }

    console.log(`[AutoResolutionCron] Successfully auto-resolved ${resolvedCount} conversations.`);
  } catch (error) {
    console.error('[AutoResolutionCron] Error executing cron:', error.message);
  }
});

module.exports = true;
