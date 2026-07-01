'use strict';

const FollowUpSequence = require('../../models/FollowUpSequence');
const { enqueueSequenceStepJob } = require('./queues/sequenceDispatchQueue');
const { tryTransitionSequenceStep } = require('./transitions/sequenceStepTransition');
const { journeyLog, journeyLogWarn } = require('../journeyBuilder/journeyPipelineLog');
const log = require('../core/logger')('SequenceStepEnqueue');

/**
 * Enqueue BullMQ jobs for sequence steps that are due (sendAt <= now).
 * Uses atomic pending→queued so workers never race with in-memory status saves.
 */
async function enqueueDueStepsForSequence(sequenceOrId, { now = new Date() } = {}) {
  const seqId =
    sequenceOrId && typeof sequenceOrId === 'object' && sequenceOrId._id
      ? sequenceOrId._id
      : sequenceOrId;

  const seq = await FollowUpSequence.findById(seqId).lean();
  if (!seq || seq.status !== 'active') {
    journeyLogWarn('enqueue', 'sequence not active — skipped', {
      sequenceId: String(seqId || ''),
      status: seq?.status || 'missing',
    });
    return 0;
  }

  let enqueued = 0;
  const steps = seq.steps || [];

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    if (!step?.sendAt || new Date(step.sendAt) > now) continue;

    const stepType = String(step.type || 'whatsapp').toLowerCase();
    const channel = stepType === 'email' ? 'email' : 'whatsapp';
    const delayMs = Math.max(0, new Date(step.sendAt).getTime() - now.getTime());
    const baseMeta = {
      clientId: seq.clientId,
      sequenceId: String(seq._id),
      stepIdx: idx,
      stepType,
      channel,
      sendAt: step.sendAt,
    };

    if (step.status === 'pending') {
      const claimed = await tryTransitionSequenceStep(seq._id, idx, 'pending', 'queued');
      if (!claimed.ok) {
        if (claimed.code === 'transition_conflict') {
          journeyLog('enqueue', 'step already claimed by another worker', {
            ...baseMeta,
            fromStatus: 'pending',
          });
        } else {
          journeyLogWarn('enqueue', 'pending→queued blocked', {
            ...baseMeta,
            reason: claimed.message,
          });
        }
        continue;
      }

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
        journeyLog('enqueue', 'step queued for dispatch', baseMeta);
      } catch (e) {
        await tryTransitionSequenceStep(seq._id, idx, 'queued', 'pending').catch(() => {});
        journeyLogWarn('enqueue', 'queue add failed — rolled back to pending', {
          ...baseMeta,
          error: e.message,
        });
      }
      continue;
    }

    if (step.status === 'retrying') {
      if (step.nextAttemptAt && new Date(step.nextAttemptAt) > now) continue;
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
        journeyLog('enqueue', 'retry step re-queued', baseMeta);
      } catch (e) {
        if (!String(e.message || '').toLowerCase().includes('already')) {
          log.warn(`Enqueue retry failed ${seq._id}:${idx}: ${e.message}`);
          journeyLogWarn('enqueue', 'retry queue add failed', { ...baseMeta, error: e.message });
        }
      }
    }
  }

  if (enqueued) {
    journeyLog('enqueue', 'due steps enqueued', {
      clientId: seq.clientId,
      sequenceId: String(seq._id),
      enqueued,
      stepCount: steps.length,
    });
  }

  return enqueued;
}

module.exports = { enqueueDueStepsForSequence };
