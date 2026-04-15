const TRACKABLE_ASSETS = require('../constants/trackableAssets');

const ASSET_MAP = {
  // COMMERCE
  TOTAL_ORDERS: 'ordersCount',
  LTV: 'totalSpent',
  ABANDONED_CARTS: 'addToCartCount',
  CHECKOUT_COUNT: 'checkoutInitiatedCount',
  RTO_COUNT: 'rtoCount',
  EXCHANGE_REFUND_COUNT: 'refundCount',
  DAYS_SINCE_LAST_PURCHASE: 'lastPurchaseDate',
  
  // ENGAGEMENT
  TOTAL_INTERACTIONS: 'inboundMessageCount',
  DAYS_SINCE_LAST_SEEN: 'lastInteraction',
  APPOINTMENTS_COUNT: 'appointmentsBooked'
};

/**
 * Helper to extract or calculate the actual value of an asset from a customer record.
 * Includes "Double-Test" validation to return safe defaults if data is missing.
 */
const getAssetValue = (lead, assetConfig) => {
  const assetId = assetConfig.id;

  // 1. Specialized Logic: JUST_LANDED
  if (assetId === 'JUST_LANDED') {
    const orders = lead.ordersCount || 0;
    const msgs = lead.inboundMessageCount || 0;
    return (orders === 0 && msgs <= 1);
  }
  
  // 2. Specialized Logic: Date-based calculations (CALCULATED_DAYS)
  if (assetConfig.type === 'CALCULATED_DAYS') {
    const dbField = ASSET_MAP[assetId] || assetConfig.dbField;
    const dateValue = lead[dbField];
    
    // VALIDATION: If date is missing, return Infinity (safely far in the past/future)
    if (!dateValue) return Infinity; 
    
    const diffTime = Math.abs(new Date() - new Date(dateValue));
    return Math.floor(diffTime / (1000 * 60 * 60 * 24)); 
  }

  // 3. Mapping-based extraction with fallback (Double-Test)
  const dbField = ASSET_MAP[assetId] || assetConfig.dbField;
  const value = lead[dbField];

  // VALIDATION: Ensure we return 0 for numbers or false for booleans if missing
  if (value === undefined || value === null) {
      return assetConfig.type === 'BOOLEAN' ? false : 0;
  }

  return value;
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
 * @returns {Object} { score: Number, label: String }
 */
const evaluateCustomerScore = (lead, tierConfig) => {
  if (!tierConfig || !tierConfig.tiers || tierConfig.tiers.length === 0) {
    return { score: 0, label: 'Unprocessed' };
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
        break; 
      }

      const actualValue = getAssetValue(lead, assetConfig);
      const passed = evaluateCondition(actualValue, condition.operator, condition.targetValue);

      if (!passed) {
        passedAllConditions = false;
        break; 
      }
    }

    if (passedAllConditions) {
      return { 
          score: tier.score, 
          label: tier.tierLabel || tier.label || `Tier ${tier.score}` 
      };
    }
  }

  return { score: 0, label: 'Cold Lead' }; 
};

module.exports = { evaluateCustomerScore };
