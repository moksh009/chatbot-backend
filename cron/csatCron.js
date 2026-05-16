const cron = require('node-cron');
const Conversation = require('../models/Conversation');
const { triggerCSAT, triggerIdleCSAT } = require('../utils/csatService');
const log = require('../utils/logger')('CsatCron');

const scheduleCsatCron = () => {
  // Resolved conversations — survey ~1h after close
  cron.schedule('*/10 * * * *', async () => {
    try {
      const resolved = await Conversation.find({
        status: 'CLOSED',
        channel: 'whatsapp',
        resolvedAt: { $lte: new Date(Date.now() - 55 * 60 * 1000) },
        csatSent: { $ne: true },
        $or: [{ csatScore: { $exists: false } }, { 'csatScore.rating': { $exists: false } }],
      }).limit(40);

      for (const convo of resolved) {
        await triggerCSAT(convo);
      }
    } catch (err) {
      log.error('Resolved CSAT pass failed', { error: err.message });
    }
  });

  // Idle conversations — no messages for 90+ minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      const idleCutoff = new Date(Date.now() - 90 * 60 * 1000);
      const idle = await Conversation.find({
        channel: 'whatsapp',
        status: { $in: ['BOT_ACTIVE', 'WAITING_FOR_INPUT', 'HUMAN_TAKEOVER', 'HUMAN_SUPPORT'] },
        lastMessageAt: { $lte: idleCutoff },
        csatSent: { $ne: true },
        botPaused: { $ne: true },
        $or: [{ csatScore: { $exists: false } }, { 'csatScore.rating': { $exists: false } }],
      }).limit(50);

      for (const convo of idle) {
        await triggerIdleCSAT(convo);
      }
    } catch (err) {
      log.error('Idle CSAT pass failed', { error: err.message });
    }
  });
};

module.exports = scheduleCsatCron;
