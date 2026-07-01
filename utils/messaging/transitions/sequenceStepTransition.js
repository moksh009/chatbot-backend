'use strict';

const FollowUpSequence = require('../../../models/FollowUpSequence');

// Explicit allowed transitions for journey sequence steps.
// pending → queued is the primary enqueue path (API enroll + cron scheduler).
// queued  → pending is the rollback if BullMQ job add fails.
const ALLOWED = {
  pending:    new Set(['queued', 'processing', 'sent', 'failed', 'skipped', 'cancelled']),
  queued:     new Set(['pending', 'processing', 'cancelled', 'skipped']),
  processing: new Set(['sent', 'retrying', 'failed', 'cancelled', 'skipped']),
  retrying:   new Set(['processing', 'cancelled', 'skipped']),
  sent:       new Set([]),
  failed:     new Set([]),
  cancelled:  new Set([]),
  skipped:    new Set([]),
};

// Startup diagnostic — visible in PM2 logs immediately after deploy.
// If this prints false, the module was somehow loaded from a cached/old version.
console.log(
  '[SequenceTransition] ALLOWED map loaded:',
  'pending→queued=' + ALLOWED.pending.has('queued'),
  'queued→processing=' + ALLOWED.queued.has('processing'),
  'processing→sent=' + ALLOWED.processing.has('sent')
);

function assertStepTransition(fromStatus, toStatus) {
  const from = String(fromStatus || 'pending');
  const to   = String(toStatus);
  const allowed = ALLOWED[from];
  if (!allowed || !allowed.has(to)) {
    const err = new Error(`invalid_sequence_step_transition:${from}->${to}`);
    err.code = 'invalid_transition';
    throw err;
  }
}

/**
 * Atomically transition a sequence step from `fromStatus` to `toStatus`.
 * Uses compare-and-swap (findOneAndUpdate with status filter) to prevent races.
 *
 * Idempotent recovery: if the DB update finds no matching doc (conflict),
 * we do a secondary read to check whether the step already reached `toStatus`
 * (e.g. another worker beat us). If so, we return the current doc as success.
 */
async function transitionSequenceStep(sequenceId, stepIdx, fromStatus, toStatus, patch = {}) {
  assertStepTransition(fromStatus, toStatus);

  const path = `steps.${stepIdx}`;
  const filter = {
    _id: sequenceId,
    [`${path}.status`]: fromStatus,
  };
  const $set = { [`${path}.status`]: toStatus };
  for (const [k, v] of Object.entries(patch)) {
    $set[`${path}.${k}`] = v;
  }

  const doc = await FollowUpSequence.findOneAndUpdate(filter, { $set }, { new: true });
  if (doc) return doc;

  // Primary update missed — the step is no longer in `fromStatus`.
  // Check if it already reached `toStatus` (idempotent re-try by another process).
  const current = await FollowUpSequence.findById(sequenceId)
    .select(`${path}.status status`)
    .lean();

  if (current?.steps?.[stepIdx]?.status === toStatus) {
    // Step is already where we want it; treat as success.
    const fresh = await FollowUpSequence.findById(sequenceId).lean();
    if (fresh) return fresh;
  }

  const err = new Error('sequence_step_transition_conflict');
  err.code = 'transition_conflict';
  throw err;
}

/**
 * Non-throwing wrapper — returns { ok, doc?, code?, message? }.
 * Use in workers and enqueue paths to avoid marking steps failed on benign races.
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
  const doc = await FollowUpSequence.findById(sequenceId)
    .select(`steps.${stepIdx}.status status`)
    .lean();
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
