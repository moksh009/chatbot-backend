const cron = require('node-cron');
const Conversation = require('../models/Conversation');
const { triggerCSAT, triggerIdleCSAT } = require('../utils/csatService');
const log = require('../utils/logger')('CsatCron');

async function runPrimaryCsatTick() {
  const resolved = await Conversation.find({
    status: 'CLOSED',
    channel: 'whatsapp',
    resolvedAt: { $lte: new Date(Date.now() - 55 * 60 * 1000) },
    csatSent: { $ne: true },
    $or: [{ csatScore: { $exists: false } }, { 'csatScore.rating': { $exists: false } }],
  })
    .select('_id clientId phone status')
    .limit(40)
    .lean();

  for (const convo of resolved) {
    await triggerCSAT(convo);
  }
}

async function runSecondaryCsatTick() {
  const idleCutoff = new Date(Date.now() - 90 * 60 * 1000);
  const idle = await Conversation.find({
    channel: 'whatsapp',
    status: { $in: ['BOT_ACTIVE', 'WAITING_FOR_INPUT', 'HUMAN_TAKEOVER', 'HUMAN_SUPPORT'] },
    lastMessageAt: { $lte: idleCutoff },
    csatSent: { $ne: true },
    botPaused: { $ne: true },
    $or: [{ csatScore: { $exists: false } }, { 'csatScore.rating': { $exists: false } }],
  })
    .select('_id clientId phone status lastMessageAt')
    .limit(50)
    .lean();

  for (const convo of idle) {
    await triggerIdleCSAT(convo);
  }
}

const scheduleCsatCron = () => {
  if (process.env.CRON_USE_COORDINATOR === 'true') return;

  cron.schedule('*/10 * * * *', async () => {
    try {
      await runPrimaryCsatTick();
    } catch (err) {
      log.error('Resolved CSAT pass failed', { error: err.message });
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    try {
      await runSecondaryCsatTick();
    } catch (err) {
      log.error('Idle CSAT pass failed', { error: err.message });
    }
  });
};

scheduleCsatCron.runPrimaryTick = runPrimaryCsatTick;
scheduleCsatCron.runSecondaryTick = runSecondaryCsatTick;
module.exports = scheduleCsatCron;
