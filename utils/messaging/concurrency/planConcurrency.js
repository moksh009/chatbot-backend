const { resolvePlanLimits } = require('../../../config/planCatalog');

const PLAN_MAX_PARALLEL = {
  diy_lite: 5,
  diy_pro: 15,
  diy_scale: 50,
  dfy_launch: 25,
  dfy_growth: 75,
  dfy_enterprise: 200,
  trial: 5,
};

const CHANNEL_DEFAULTS = {
  whatsapp: 10,
  email: 20,
  instagram: 5,
};

function resolveMaxParallel(client, channel = 'whatsapp') {
  if (channel === 'webhook') {
    return Number(process.env.PHASE9_WEBHOOK_TENANT_CONCURRENCY || 10);
  }
  const planSlug = client?.subscriptionPlan || client?.plan || 'diy_lite';
  resolvePlanLimits(planSlug);
  const planCap = PLAN_MAX_PARALLEL[planSlug] || PLAN_MAX_PARALLEL.diy_lite;
  const configured = Number(client?.complianceConfig?.concurrency?.[channel]?.maxParallel);
  const channelDefault = CHANNEL_DEFAULTS[channel] || 10;
  const tenantCap = Number.isFinite(configured) && configured > 0 ? configured : channelDefault;
  return Math.min(planCap, tenantCap);
}

module.exports = { resolveMaxParallel, PLAN_MAX_PARALLEL };
