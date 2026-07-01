const cron = require('node-cron');
const FollowUpSequence = require('../models/FollowUpSequence');
const { enqueueDueStepsForSequence } = require('../utils/messaging/sequenceStepEnqueue');
const log = require('../utils/core/logger')('SequenceDispatchScheduler');
const { logDispatchEvent } = require('../utils/messaging/dispatchEventLog');

/**
 * Scheduler-only: enqueue due steps — no direct sends (Phase 3 Module 5).
 */
async function runSequenceDispatchSchedulerTick() {
  const started = Date.now();
  const now = new Date();
  const due = await FollowUpSequence.find({
    status: 'active',
    steps: {
      $elemMatch: {
        sendAt: { $lte: now },
        status: 'pending',
      },
    },
  })
    .select('_id clientId leadId steps')
    .limit(500);

  let enqueued = 0;
  for (const seq of due) {
    enqueued += await enqueueDueStepsForSequence(seq, { now });
  }

  logDispatchEvent('SequenceDispatchScheduler', 'sequence_scheduler_tick', {
    dueSequences: due.length,
    enqueued,
    durationMs: Date.now() - started,
    outcome: enqueued > 0 ? 'enqueued' : 'idle',
  });
  if (enqueued) log.info(`Enqueued ${enqueued} sequence step jobs`);
}

const scheduleSequenceDispatchScheduler = () => {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  cron.schedule('*/2 * * * *', runSequenceDispatchSchedulerTick);
};

scheduleSequenceDispatchScheduler.runTick = runSequenceDispatchSchedulerTick;
module.exports = scheduleSequenceDispatchScheduler;
