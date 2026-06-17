'use strict';

const Message = require('../../models/Message');
const { normalizePhone } = require('../core/helpers');

function lastSentStepIndex(steps = []) {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]?.status === 'sent' && steps[i]?.sentAt) return i;
  }
  return -1;
}

/**
 * Evaluate optional step.condition before dispatch.
 * Supported: replied / if_replied / require_reply, no_reply / if_no_reply / skip_if_replied.
 */
async function evaluateSequenceStepCondition({ clientId, phone, step, sequence }) {
  const condition = String(step?.condition || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_');
  if (!condition) return { proceed: true };

  const phoneNorm = normalizePhone(phone);
  if (!clientId || !phoneNorm) return { proceed: true };

  const steps = sequence?.steps || [];
  const lastSentIdx = lastSentStepIndex(steps);
  const since =
    lastSentIdx >= 0
      ? new Date(steps[lastSentIdx].sentAt)
      : sequence?.createdAt
        ? new Date(sequence.createdAt)
        : new Date(0);

  const inboundCount = await Message.countDocuments({
    clientId,
    phone: phoneNorm,
    direction: 'inbound',
    createdAt: { $gte: since },
  });

  if (['replied', 'if_replied', 'require_reply'].includes(condition)) {
    return { proceed: inboundCount > 0, reason: inboundCount > 0 ? null : 'condition_require_reply' };
  }
  if (['no_reply', 'if_no_reply', 'skip_if_replied'].includes(condition)) {
    return { proceed: inboundCount === 0, reason: inboundCount === 0 ? null : 'condition_no_reply' };
  }

  return { proceed: true };
}

module.exports = { evaluateSequenceStepCondition, lastSentStepIndex };
