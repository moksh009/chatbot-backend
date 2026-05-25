const usageTracker = require('../../services/billing/usageTracker');
const log = require('../core/logger')('BillingService');

/**
 * @deprecated Phase 4 — delegates to services/billing/usageTracker.js
 */
class BillingService {
  async checkLimit(clientId, metric) {
    return usageTracker.checkLimit({ clientId, key: metric });
  }

  async incrementUsage(clientId, metric, increment = 1) {
    return usageTracker.incrementUsage({ clientId, key: metric, by: increment });
  }

  async getUsageReport(clientId) {
    const Client = require('../../models/Client');
    const Subscription = require('../../models/Subscription');
    const sub = await Subscription.findOne({ clientId }).lean();
    const client = await Client.findOne({ clientId }).select('limits trialActive trialEndsAt isPaidAccount').lean();
    if (!client) return null;
    return {
      usage: sub?.usageThisPeriod || {},
      limits: client.limits,
      trialActive: client.trialActive,
      trialEndsAt: client.trialEndsAt,
      isPaid: client.isPaidAccount,
    };
  }
}

module.exports = new BillingService();
