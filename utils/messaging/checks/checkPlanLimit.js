const { checkLimit } = require('../../core/planLimits');
const NodeCache = require('node-cache');

// Plan checks hit Mongo/Subscription on every outbound send; short cache removes hot-path latency.
const planLimitCache = new NodeCache({ stdTTL: 20, checkperiod: 30, useClones: false });

async function checkPlanLimit({ clientId }) {
  const cacheKey = `messages:${clientId}`;
  const cached = planLimitCache.get(cacheKey);
  if (cached) return cached;

  const limit = await checkLimit(clientId, 'messages');
  if (!limit?.allowed) {
    const blocked = {
      pass: false,
      blockedBy: 'plan_limit',
      reason: limit.reason || 'plan_limit_exhausted',
    };
    // Keep blocked responses short-lived so upgrades/unfreezes become active quickly.
    planLimitCache.set(cacheKey, blocked, 5);
    return blocked;
  }
  const ok = { pass: true };
  planLimitCache.set(cacheKey, ok);
  return ok;
}

module.exports = { checkPlanLimit };
