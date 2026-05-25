const { checkLimit } = require('../../core/planLimits');

async function checkPlanLimit({ clientId }) {
  const limit = await checkLimit(clientId, 'messages');
  if (!limit?.allowed) {
    return { pass: false, blockedBy: 'plan_limit', reason: limit.reason || 'plan_limit_exhausted' };
  }
  return { pass: true };
}

module.exports = { checkPlanLimit };
