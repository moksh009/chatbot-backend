const cron = require('node-cron');
const FollowUpSequence = require('../models/FollowUpSequence');
const { enqueueDueStepsForSequence } = require('../utils/messaging/sequenceStepEnqueue');
const log = require('../utils/core/logger')('SequenceDispatchScheduler');

/**
 * Scheduler-only: enqueue due steps — no direct sends (Phase 3 Module 5).
 */
async function runSequenceDispatchSchedulerTick() {
  const now = new Date();
  const due = await FollowUpSequence.find({
    status: 'active',
    steps: {
      $elemMatch: {
        sendAt: { $lte: now },
        status: { $in: ['pending', 'retrying'] },
      },
    },
  })
    .select('_id clientId leadId steps')
    .limit(500);

  let enqueued = 0;
  for (const seq of due) {
    enqueued += await enqueueDueStepsForSequence(seq, { now });
  }
  if (enqueued) log.info(`Enqueued ${enqueued} sequence step jobs`);
}

const scheduleSequenceDispatchScheduler = () => {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  cron.schedule('*/2 * * * *', runSequenceDispatchSchedulerTick);
};

scheduleSequenceDispatchScheduler.runTick = runSequenceDispatchSchedulerTick;
module.exports = scheduleSequenceDispatchScheduler;
