const cron = require('node-cron');
const FollowUpSequence = require('../models/FollowUpSequence');
const { enqueueSequenceStepJob } = require('../utils/messaging/queues/sequenceDispatchQueue');
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
        status: { $in: ['pending', 'queued', 'retrying'] },
      },
    },
  })
    .select('_id clientId leadId steps')
    .limit(500);

  let enqueued = 0;
  for (const seq of due) {
    seq.steps.forEach((step, idx) => {
      const dueStep =
        step.sendAt &&
        step.sendAt <= now &&
        ['pending', 'queued', 'retrying'].includes(step.status);
      if (!dueStep) return;
      if (step.status === 'pending') step.status = 'queued';
      const channel = step.type === 'email' ? 'email' : 'whatsapp';
      enqueueSequenceStepJob({
        sequenceId: String(seq._id),
        stepIdx: idx,
        leadId: String(seq.leadId),
        clientId: seq.clientId,
        channel,
      }).catch((e) => log.warn(`Enqueue failed ${seq._id}:${idx}: ${e.message}`));
      enqueued += 1;
    });
    await seq.save();
  }
  if (enqueued) log.info(`Enqueued ${enqueued} sequence step jobs`);
}

const scheduleSequenceDispatchScheduler = () => {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  cron.schedule('*/2 * * * *', runSequenceDispatchSchedulerTick);
};

scheduleSequenceDispatchScheduler.runTick = runSequenceDispatchSchedulerTick;
module.exports = scheduleSequenceDispatchScheduler;
