const FollowUpSequence = require('../../../models/FollowUpSequence');

const ALLOWED = {
  queued: new Set(['processing', 'cancelled', 'skipped']),
  pending: new Set(['processing', 'sent', 'failed', 'skipped', 'cancelled']),
  processing: new Set(['sent', 'retrying', 'failed', 'cancelled', 'skipped']),
  retrying: new Set(['processing', 'cancelled', 'skipped']),
  sent: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
  skipped: new Set([]),
};

function assertStepTransition(fromStatus, toStatus) {
  const from = String(fromStatus || 'pending');
  const to = String(toStatus);
  const allowed = ALLOWED[from];
  if (!allowed || !allowed.has(to)) {
    const err = new Error(`invalid_sequence_step_transition:${from}->${to}`);
    err.code = 'invalid_transition';
    throw err;
  }
}

async function transitionSequenceStep(sequenceId, stepIdx, fromStatus, toStatus, patch = {}) {
  assertStepTransition(fromStatus, toStatus);
  const path = `steps.${stepIdx}`;
  const filter = {
    _id: sequenceId,
    [`${path}.status`]: fromStatus,
  };
  const $set = {
    [`${path}.status`]: toStatus,
  };
  for (const [k, v] of Object.entries(patch)) {
    $set[`${path}.${k}`] = v;
  }
  const doc = await FollowUpSequence.findOneAndUpdate(filter, { $set }, { new: true });
  if (!doc) {
    const err = new Error('sequence_step_transition_conflict');
    err.code = 'transition_conflict';
    throw err;
  }
  return doc;
}

/**
 * Non-throwing transition — returns { ok, doc?, code?, message? }.
 * Use in workers/enqueue to avoid marking steps failed on benign races.
 */
async function tryTransitionSequenceStep(sequenceId, stepIdx, fromStatus, toStatus, patch = {}) {
  try {
    const doc = await transitionSequenceStep(sequenceId, stepIdx, fromStatus, toStatus, patch);
    return { ok: true, doc };
  } catch (err) {
    if (err.code === 'transition_conflict' || err.code === 'invalid_transition') {
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
}

async function readSequenceStepStatus(sequenceId, stepIdx) {
  const doc = await FollowUpSequence.findById(sequenceId).select(`steps.${stepIdx}.status status`).lean();
  if (!doc) return { sequenceStatus: null, stepStatus: null };
  return {
    sequenceStatus: doc.status,
    stepStatus: doc.steps?.[stepIdx]?.status || null,
  };
}

module.exports = {
  transitionSequenceStep,
  tryTransitionSequenceStep,
  readSequenceStepStatus,
  assertStepTransition,
  ALLOWED,
};
