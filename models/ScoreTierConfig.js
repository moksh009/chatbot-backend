const mongoose = require('mongoose');

const ConditionSchema = new mongoose.Schema({
  assetId: { type: String, required: true }, // e.g., 'TOTAL_ORDERS'
  operator: { type: String, required: true }, // e.g., '>='
  targetValue: { type: mongoose.Schema.Types.Mixed, required: true } // Can be Number or Boolean
});

const TierSchema = new mongoose.Schema({
  score: { type: Number, required: true }, // e.g., 100, 90, ..., 0
  tierLabel: { type: String }, // Custom naming (e.g., "VIP", "Churn Risk")
  conditions: [ConditionSchema] // Evaluated with AND logic
});

// Legacy support for 'label'
TierSchema.virtual('label').get(function() { return this.tierLabel; }).set(function(v) { this.tierLabel = v; });
const ScoreTierConfigSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  isActive: { type: Boolean, default: true },
  tiers: [TierSchema],
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

ScoreTierConfigSchema.statics.getDefaultConfig = function(clientId) {
  return {
    clientId,
    isActive: true,
    tiers: [
      { score: 100, tierLabel: "VIP / Direct Buyer", conditions: [{ assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 5 }] },
      { score: 90, tierLabel: "Loyal Customer", conditions: [{ assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 3 }] },
      { score: 80, tierLabel: "Repeat Buyer", conditions: [{ assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 1 }] },
      { score: 70, tierLabel: "High Intent", conditions: [{ assetId: 'CHECKOUT_COUNT', operator: '>=', targetValue: 2 }] },
      { score: 60, tierLabel: "Warm Lead", conditions: [{ assetId: 'ADD_TO_CART_COUNT', operator: '>=', targetValue: 1 }] },
      { score: 50, tierLabel: "Active Shopper", conditions: [{ assetId: 'TOTAL_INTERACTIONS', operator: '>=', targetValue: 10 }] },
      { score: 40, tierLabel: "Interested", conditions: [{ assetId: 'TOTAL_INTERACTIONS', operator: '>=', targetValue: 5 }] },
      { score: 30, tierLabel: "Browsing", conditions: [{ assetId: 'TOTAL_INTERACTIONS', operator: '>=', targetValue: 2 }] },
      { score: 20, tierLabel: "New Visitor", conditions: [{ assetId: 'TOTAL_INTERACTIONS', operator: '>=', targetValue: 1 }] },
      { score: 10, tierLabel: "Cold Lead", conditions: [] },
      { score: 0, tierLabel: "Unprocessed", conditions: [] }
    ]
  };
};

module.exports = mongoose.model('ScoreTierConfig', ScoreTierConfigSchema);
