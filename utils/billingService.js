const Client = require('../models/Client');

/**
 * Phase 17 SaaS Billing & Usage Service
 * Tracks and enforces tiered limits for Meta/WA messages and AI calls.
 */
class BillingService {
  
  /**
   * Check if a client has reached their monthly limit for a specific metric.
   * @param {String} clientId 
   * @param {String} metric - 'messagesSent', 'aiCallsMade', 'campaignsSent'
   * @returns {Object} { allowed: Boolean, current: Number, limit: Number }
   */
  async checkLimit(clientId, metric) {
    const client = await Client.findOne({ clientId });
    if (!client) return { allowed: false, message: 'Client not found' };

    // Reset usage if month has changed
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (client.usage.month !== currentMonth) {
      client.usage.month = currentMonth;
      client.usage.messagesSent = 0;
      client.usage.aiCallsMade = 0;
      client.usage.campaignsSent = 0;
      client.usage.leadsCreated = 0;
      client.usage.lastResetAt = new Date();
      await client.save();
    }

    const currentUsage = client.usage[metric] || 0;
    const limitMap = {
      messagesSent: client.limits?.messagesPerMonth || 1000,
      aiCallsMade: client.limits?.aiCallsPerMonth || 500,
      campaignsSent: client.limits?.campaignsPerMonth || 5
    };

    const limit = limitMap[metric];
    const allowed = currentUsage < limit;

    return {
      allowed,
      current: currentUsage,
      limit,
      isTrial: client.trialActive
    };
  }

  /**
   * Atomically increment usage for a client.
   * @param {String} clientId 
   * @param {String} metric 
   * @param {Number} increment 
   */
  async incrementUsage(clientId, metric, increment = 1) {
    try {
      const update = { $inc: {} };
      update.$inc[`usage.${metric}`] = increment;
      
      await Client.findOneAndUpdate(
        { clientId },
        update,
        { upsert: false }
      );
    } catch (error) {
      console.error(`[BillingService] Error incrementing ${metric} for ${clientId}:`, error);
    }
  }

  /**
   * Get formatted usage report for dashboard.
   */
  async getUsageReport(clientId) {
    const client = await Client.findOne({ clientId });
    if (!client) return null;

    return {
      usage: client.usage,
      limits: client.limits,
      trialActive: client.trialActive,
      trialEndsAt: client.trialEndsAt,
      isPaid: client.isPaidAccount
    };
  }
}

module.exports = new BillingService();
