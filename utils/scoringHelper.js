const ScoreTierConfig = require('../models/ScoreTierConfig');
const AdLead = require('../models/AdLead');
const { evaluateCustomerScore } = require('../services/ScoreEvaluationService');

/**
 * Enterprise Scoring Proxy
 * Recalculates and saves a lead's score using the Waterfall Engine.
 * Call this whenever a customer metric (orders, messages, etc.) changes.
 */
const recalculateLeadScore = async (clientId, phoneNumber) => {
  try {
    // 1. Fetch the lead and the client's waterfall configuration
    const [lead, tierConfig] = await Promise.all([
      AdLead.findOne({ clientId, phoneNumber }),
      ScoreTierConfig.findOne({ clientId })
    ]);

    if (!lead) {
      console.warn(`[RECOMPUTE_SCORE] Lead not found: ${phoneNumber} for client ${clientId}`);
      return null;
    }

    if (!tierConfig) {
      // Fallback: If no config, could default to 0 or a basic linear score
      return lead.leadScore; 
    }

    // 2. Run the Engine (returns { score, label })
    const { score, label } = evaluateCustomerScore(lead, tierConfig);

    // 3. Persist and Broadcast
    lead.leadScore = score;
    lead.scoreLabel = label;
    await lead.save();

    console.log(`[RECOMPUTE_SCORE] ${phoneNumber} matched tier: ${label}. New Score: ${score}`);
    
    // Optional: Emit socket event here if real-time CRM updates are desired
    // global.io.to(`client_${clientId}`).emit('lead_score_updated', { phoneNumber, score, label });

    return score;
  } catch (err) {
    console.error(`[RECOMPUTE_SCORE] Failed for ${phoneNumber}:`, err.message);
    return null;
  }
};

module.exports = { recalculateLeadScore };
