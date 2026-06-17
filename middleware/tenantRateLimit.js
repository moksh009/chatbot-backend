'use strict';

const { getAppRedis } = require('../utils/core/redisFactory');
const { resolvePlanLimits } = require('../config/planCatalog');
const Client = require('../models/Client');
const { auditLog } = require('../services/audit/auditWriter');

const EXEMPT_PREFIXES = [
  '/api/auth',
  '/api/public',
  '/webhook',
  '/whatsapp-webhook',
  '/api/shopify/webhook',
  '/api/ig-automation/webhook',
  '/api/admin',
];

const PLAN_RPM = {
  diy_lite: 60,
  diy_pro: 300,
  diy_scale: 1200,
  dfy_launch: 600,
  dfy_growth: 1200,
  dfy_enterprise: 2400,
  trial: 60,
};

/** Local dev dashboards burst past production RPM; keep prod limits strict. */
const IS_NON_PROD = process.env.NODE_ENV !== 'production';
const ENFORCE_TENANT_IN_DEV = process.env.ENFORCE_TENANT_RATE_LIMIT === 'true';
const DEV_TENANT_RPM =
  Number(process.env.DEV_TENANT_API_RPM) > 0
    ? Number(process.env.DEV_TENANT_API_RPM)
    : 5000;

const limitCache = new Map();

async function resolveLimit(clientId) {
  const cached = limitCache.get(clientId);
  if (cached && Date.now() - cached.at < 60_000) {
    return { rpm: cached.rpm, burst: cached.burst };
  }

  const client = await Client.findOne({ clientId })
    .select('plan subscriptionPlan complianceConfig.apiRateLimit')
    .lean();
  const plan = client?.subscriptionPlan || client?.plan || 'diy_lite';
  const limits = resolvePlanLimits(plan);
  const slug = limits.slug || plan;
  const configured = client?.complianceConfig?.apiRateLimit?.requestsPerMinute;
  const rpm = Number.isFinite(configured) && configured > 0 ? configured : PLAN_RPM[slug] || 60;
  const burst = client?.complianceConfig?.apiRateLimit?.burstSize || rpm * 2;
  limitCache.set(clientId, { rpm, burst, at: Date.now() });
  return { rpm, burst };
}

function tenantRateLimit() {
  return async (req, res, next) => {
    const path = req.originalUrl || req.path || '';
    if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return next();
    if (!req.user?.clientId) return next();
    if (req.user.role === 'SUPER_ADMIN') return next();

    const redis = getAppRedis();
    if (!redis) return next();

    if (process.env.DISABLE_TENANT_RATE_LIMIT === 'true') return next();
    if (IS_NON_PROD && !ENFORCE_TENANT_IN_DEV) return next();

    const clientId = req.user.clientId;
    const pathOnly = String(path).split('?')[0];
    const isCampaignDraftPatch =
      req.method === 'PATCH' && /\/api\/campaigns\/[a-f0-9]{24}$/i.test(pathOnly);
    const key = isCampaignDraftPatch ? `api_rate_draft:${clientId}` : `api_rate:${clientId}`;
    const { rpm } = await resolveLimit(clientId);
    let effectiveRpm = IS_NON_PROD ? DEV_TENANT_RPM : rpm;
    if (isCampaignDraftPatch && !IS_NON_PROD) {
      effectiveRpm = Math.max(effectiveRpm, effectiveRpm * 4);
    }
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);

    if (count > effectiveRpm) {
      const retryAfter = 60 - (Date.now() / 1000) % 60;
      res.setHeader('Retry-After', String(Math.ceil(retryAfter)));
      if (count === rpm + 1 || count % 100 === 0) {
        auditLog({
          category: 'security',
          action: 'rate_limit_exceeded',
          severity: 'warning',
          clientId,
          actor: { type: 'user', userId: req.user._id, source: 'api' },
          details: { count, rpm: effectiveRpm, path },
        });
      }
      return res.status(429).json({ error: 'rate_limit_exceeded' });
    }
    return next();
  };
}

module.exports = { tenantRateLimit };
