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

async function resolveLimit(clientId) {
  const client = await Client.findOne({ clientId })
    .select('plan subscriptionPlan complianceConfig.apiRateLimit')
    .lean();
  const plan = client?.subscriptionPlan || client?.plan || 'diy_lite';
  const limits = resolvePlanLimits(plan);
  const slug = limits.slug || plan;
  const configured = client?.complianceConfig?.apiRateLimit?.requestsPerMinute;
  const rpm = Number.isFinite(configured) && configured > 0 ? configured : PLAN_RPM[slug] || 60;
  const burst = client?.complianceConfig?.apiRateLimit?.burstSize || rpm * 2;
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

    const clientId = req.user.clientId;
    const key = `api_rate:${clientId}`;
    const { rpm } = await resolveLimit(clientId);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);

    if (count > rpm) {
      const retryAfter = 60 - (Date.now() / 1000) % 60;
      res.setHeader('Retry-After', String(Math.ceil(retryAfter)));
      if (count === rpm + 1 || count % 100 === 0) {
        auditLog({
          category: 'security',
          action: 'rate_limit_exceeded',
          severity: 'warning',
          clientId,
          actor: { type: 'user', userId: req.user._id, source: 'api' },
          details: { count, rpm, path },
        });
      }
      return res.status(429).json({ error: 'rate_limit_exceeded' });
    }
    return next();
  };
}

module.exports = { tenantRateLimit };
