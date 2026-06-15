'use strict';

const FollowUpSequence = require('../../models/FollowUpSequence');
const { enqueueSequenceStepJob } = require('./queues/sequenceDispatchQueue');
const log = require('../core/logger')('SequenceStepEnqueue');

/**
 * Enqueue BullMQ jobs for sequence steps that are due (sendAt <= now).
 * Used by the scheduler cron and immediately after enrollment.
 */
async function enqueueDueStepsForSequence(sequenceOrId, { now = new Date() } = {}) {
  const seq =
    sequenceOrId && typeof sequenceOrId === 'object' && sequenceOrId._id
      ? sequenceOrId
      : await FollowUpSequence.findById(sequenceOrId);
  if (!seq || seq.status !== 'active') return 0;

  let enqueued = 0;
  let dirty = false;
  const steps = seq.steps || [];

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    if (!step.sendAt || new Date(step.sendAt) > now) continue;
    if (!['pending', 'queued', 'retrying'].includes(step.status)) continue;

    if (step.status === 'pending') {
      step.status = 'queued';
      dirty = true;
    }

    const channel = String(step.type || '').toLowerCase() === 'email' ? 'email' : 'whatsapp';
    const delayMs = Math.max(0, new Date(step.sendAt).getTime() - now.getTime());

    try {
      await enqueueSequenceStepJob(
        {
          sequenceId: String(seq._id),
          stepIdx: idx,
          leadId: String(seq.leadId || ''),
          clientId: seq.clientId,
          channel,
        },
        { delay: delayMs }
      );
      enqueued += 1;
    } catch (e) {
      log.warn(`Enqueue failed ${seq._id}:${idx}: ${e.message}`);
    }
  }

  if (dirty) await seq.save();
  return enqueued;
}

module.exports = { enqueueDueStepsForSequence };
