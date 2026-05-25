'use strict';

const Client = require('../../models/Client');
const Subscription = require('../../models/Subscription');
const DailyTenantUsageCost = require('../../models/DailyTenantUsageCost');
const { estimateTenantCost } = require('./costEstimation');
const { resolvePlanLimits } = require('../../utils/core/planLimits');

async function rollupDailyTenantCosts(dateStr) {
  const date = dateStr || new Date().toISOString().slice(0, 10);
  const clients = await Client.find({ isActive: { $ne: false } }).select('clientId').lean();
  let n = 0;
  for (const c of clients) {
    const sub = await Subscription.findOne({ clientId: c.clientId }).lean();
    const usage = sub?.usageThisPeriod || {};
    const plan = resolvePlanLimits(sub?.plan || 'trial');
    const costBreakdown = estimateTenantCost({
      usage,
      planPriceInr: plan?.priceInr || 0,
    });
    await DailyTenantUsageCost.findOneAndUpdate(
      { clientId: c.clientId, date },
      {
        $set: {
          usage,
          costBreakdown,
          planPriceInr: plan?.priceInr || 0,
        },
      },
      { upsert: true }
    );
    n += 1;
  }
  return n;
}

module.exports = { rollupDailyTenantCosts };
