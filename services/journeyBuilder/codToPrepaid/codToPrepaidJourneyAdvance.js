'use strict';

const FollowUpSequence = require('../../../models/FollowUpSequence');
const { enqueueDueStepsForSequence } = require('../../../utils/messaging/sequenceStepEnqueue');
const { updateSequenceContext } = require('../sequenceContextService');
const { parseCodPrepaidOutcomeCondition } = require('./codToPrepaidBranchGates');
const log = require('../../../utils/core/logger')('CodToPrepaidAdvance');

/**
 * After async conversion, advance enrollment steps on the "Converted" branch.
 */
async function advanceJourneyToCodPrepaidConverted({ clientId, enrollmentId, graphNodeId }) {
  if (!enrollmentId || !graphNodeId) return { ok: false, reason: 'missing_args' };

  const seq = await FollowUpSequence.findOne({
    _id: enrollmentId,
    ...(clientId ? { clientId } : {}),
    status: 'active',
  });

  if (!seq) return { ok: false, reason: 'sequence_not_active' };

  const outcomes =
    (seq.sequenceContext?.codPrepaidOutcomes && typeof seq.sequenceContext.codPrepaidOutcomes === 'object')
      ? { ...seq.sequenceContext.codPrepaidOutcomes }
      : {};
  outcomes[String(graphNodeId)] = 'converted';

  await updateSequenceContext(seq._id, 'codPrepaidOutcomes', outcomes, { clientId: seq.clientId });
  await updateSequenceContext(seq._id, `codPrepaidOutcome_${graphNodeId}`, 'converted', {
    clientId: seq.clientId,
  });

  const targetCondition = `cod_prepaid_outcome:converted:${graphNodeId}`;
  const now = new Date();
  let touched = false;

  for (let i = 0; i < (seq.steps || []).length; i += 1) {
    const step = seq.steps[i];
    const cond = String(step?.condition || '').trim();
    if (cond !== targetCondition) continue;
    if (!['pending', 'queued', 'skipped'].includes(step.status)) continue;

    seq.steps[i].sendAt = now;
    if (step.status === 'queued' || step.status === 'skipped') {
      seq.steps[i].status = 'pending';
      seq.steps[i].skipReason = '';
    }
    touched = true;
  }

  if (touched) {
    seq.markModified('steps');
    await seq.save();
    await enqueueDueStepsForSequence(seq._id);
    log.info('advanced journey to COD prepaid converted branch', {
      clientId: seq.clientId,
      enrollmentId: String(seq._id),
      graphNodeId,
    });
  }

  return { ok: true, touched };
}

function getCodPrepaidOutcomeFromContext(sequence, graphNodeId) {
  const ctx = sequence?.sequenceContext || {};
  if (ctx.codPrepaidOutcomes && ctx.codPrepaidOutcomes[graphNodeId]) {
    return String(ctx.codPrepaidOutcomes[graphNodeId]);
  }
  if (ctx[`codPrepaidOutcome_${graphNodeId}`]) {
    return String(ctx[`codPrepaidOutcome_${graphNodeId}`]);
  }
  return '';
}

/**
 * Evaluate cod_prepaid_outcome:<outcome>:<graphNodeId> conditions.
 */
function evaluateCodPrepaidOutcomeCondition(sequence, condition) {
  const parsed = parseCodPrepaidOutcomeCondition(condition);
  if (!parsed) return null;

  const actual = getCodPrepaidOutcomeFromContext(sequence, parsed.graphNodeId);

  if (parsed.outcome === 'converted') {
    if (actual === 'converted') {
      return { proceed: true, reason: null };
    }
    return { proceed: false, reason: 'cod_prepaid_outcome_pending', defer: true };
  }

  if (!actual) {
    return { proceed: false, reason: 'cod_prepaid_outcome_pending', defer: true };
  }

  const proceed = actual === parsed.outcome;
  return {
    proceed,
    reason: proceed ? null : `cod_prepaid_outcome_mismatch:${actual}`,
  };
}

module.exports = {
  advanceJourneyToCodPrepaidConverted,
  getCodPrepaidOutcomeFromContext,
  evaluateCodPrepaidOutcomeCondition,
};
