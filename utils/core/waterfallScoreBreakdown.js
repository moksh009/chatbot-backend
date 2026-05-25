'use strict';

const { intentStateFromWaterfall } = require('../../services/ScoreEvaluationService');

/**
 * Shape persisted on AdLead.scoreBreakdown — compatible with ScoreBreakdownPopover + waterfall detail.
 */
function buildWaterfallScoreBreakdown(lead, evaluation) {
  const score = evaluation?.score ?? 0;
  const label = evaluation?.label || 'Cold Lead';
  const intent = intentStateFromWaterfall(score, label);

  return {
    engine: 'waterfall',
    tier_label: label,
    matched_tier_score: evaluation?.matchedTier?.score ?? score,
    tier_conditions: evaluation?.conditions || [],
    intent_state: intent,
    totalCapped: score,
    updatedAt: new Date(),
    inbound_messages: { count: lead.inboundMessageCount || 0, points: 0 },
    add_to_cart: { count: lead.addToCartCount || 0, points: 0 },
    checkout_initiated: { count: lead.checkoutInitiatedCount || 0, points: 0 },
    sentiment_bonus: { points: 0 },
    decay: { points: 0 },
  };
}

module.exports = { buildWaterfallScoreBreakdown };
