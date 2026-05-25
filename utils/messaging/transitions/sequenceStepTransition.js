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

module.exports = {
  transitionSequenceStep,
  assertStepTransition,
  ALLOWED,
};
