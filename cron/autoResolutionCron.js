const cron = require('node-cron');
const Conversation = require('../models/Conversation');
const { wrapCron } = require('../utils/perfLogger');
const log = require('../utils/logger')('AutoResolutionCron');

const AUTO_RESOLVE_HOURS = 24;

function scheduleAutoResolutionCron() {
  cron.schedule(
    '0 * * * *',
    wrapCron('Auto-resolution hourly', async () => {
      const cutoffDate = new Date(Date.now() - AUTO_RESOLVE_HOURS * 60 * 60 * 1000);
      const staleConversations = await Conversation.find({
        status: { $in: ['BOT_ACTIVE', 'HUMAN_SUPPORT', 'HUMAN_TAKEOVER', 'WAITING_FOR_INPUT'] },
        lastInteraction: { $lt: cutoffDate },
        resolvedAt: { $exists: false },
      })
        .select('_id')
        .limit(200)
        .lean();

      if (!staleConversations.length) return;

      let resolvedCount = 0;
      for (const conv of staleConversations) {
        const r = await Conversation.updateOne(
          { _id: conv._id },
          { $set: { status: 'CLOSED', resolvedAt: new Date() } }
        );
        if (r.modifiedCount) resolvedCount += 1;
      }
      log.info(`Auto-resolved ${resolvedCount} stale conversations`);
    })
  );
}

module.exports = scheduleAutoResolutionCron;
