const TRACKABLE_ASSETS = require('../constants/trackableAssets');

/**
 * Helper to extract or calculate the actual value of an asset from a customer record.
 */
const getAssetValue = (customerStats, assetConfig) => {
  if (assetConfig.id === 'JUST_LANDED') {
    return (customerStats.ordersCount === 0 && customerStats.inboundMessageCount <= 1);
  }
  
  if (assetConfig.type === 'CALCULATED_DAYS') {
    const dateField = customerStats[assetConfig.dbField];
    if (!dateField) return Infinity; // Never seen/purchased
    const diffTime = Math.abs(new Date() - new Date(dateField));
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
  }

  // Default Number extraction
  return customerStats[assetConfig.dbField] || 0;
};

/**
 * Evaluates a single condition.
 */
const evaluateCondition = (actualValue, operator, targetValue) => {
  switch (operator) {
    case '>=': return actualValue >= targetValue;
    case '<=': return actualValue <= targetValue;
    case '===': return actualValue === targetValue;
    default: return false;
  }
};

/**
 * Top-Down Waterfall Evaluator
 * @param {Object} customerStats - The raw AdLead document/object.
 * @param {Object} tierConfig - The ScoreTierConfig document for this client.
 * @returns {Number} The calculated integer score.
 */
const evaluateCustomerScore = (customerStats, tierConfig) => {
  if (!tierConfig || !tierConfig.tiers || tierConfig.tiers.length === 0) {
    return 0; // Fallback if no rules configured
  }

  // Ensure tiers are sorted descending (highest score first)
  const sortedTiers = [...tierConfig.tiers].sort((a, b) => b.score - a.score);

  // Waterfall Loop
  for (const tier of sortedTiers) {
    let passedAllConditions = true;

    // AND logic: Must pass every condition in this tier block
    for (const condition of tier.conditions) {
      const assetConfig = TRACKABLE_ASSETS.ASSETS[condition.assetId];
      if (!assetConfig) {
        passedAllConditions = false;
        break; // Invalid asset, fail condition
      }

      const actualValue = getAssetValue(customerStats, assetConfig);
      const passed = evaluateCondition(actualValue, condition.operator, condition.targetValue);

      if (!passed) {
        passedAllConditions = false;
        break; // Failed this condition, move to next tier
      }
    }

    // If they survived the gauntlet for this tier, return the score immediately.
    if (passedAllConditions) {
      return tier.score;
    }
  }

  // If they pass absolutely nothing, default to 0.
  return 0; 
};

module.exports = { evaluateCustomerScore };
