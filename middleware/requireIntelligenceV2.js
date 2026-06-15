'use strict';

const Client = require('../models/Client');
const Subscription = require('../models/Subscription');
const { buildPlanAccessBundle } = require('../config/planCatalog');
const { tenantClientId } = require('../utils/core/queryHelpers');

/**
 * Blocks Intelligence Hub APIs for paid plans without intelligenceV2 (e.g. diy_lite, cx agent v1).
 * Trial users and super-admins pass through — mirrors frontend hubPathAllowed().
 */
function requireIntelligenceV2() {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.user.role === 'SUPER_ADMIN' || req.user.isLifetimeAdmin) return next();

    const clientId = tenantClientId(req) || req.user.clientId;
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const [client, sub] = await Promise.all([
      Client.findOne({ clientId }).lean(),
      Subscription.findOne({ clientId }).lean(),
    ]);
    const access = buildPlanAccessBundle(client, sub);
    if (access.intelligenceV2) return next();

    return res.status(403).json({
      error: 'plan_upgrade_required',
      code: 'intelligence_v2_required',
      message: 'Intelligence Hub requires an upgraded plan. Visit Billing to upgrade.',
    });
  };
}

module.exports = { requireIntelligenceV2 };
