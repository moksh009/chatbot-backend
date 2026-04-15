const mongoose = require('mongoose');

const ConditionSchema = new mongoose.Schema({
  assetId: { type: String, required: true }, // e.g., 'TOTAL_ORDERS'
  operator: { type: String, required: true }, // e.g., '>='
  targetValue: { type: mongoose.Schema.Types.Mixed, required: true } // Can be Number or Boolean
});

const TierSchema = new mongoose.Schema({
  score: { type: Number, required: true }, // e.g., 100, 80, 50
  label: { type: String }, // e.g., "VIP Customer"
  conditions: [ConditionSchema] // Evaluated with AND logic
});
const ScoreTierConfigSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true, index: true },
  isActive: { type: Boolean, default: true },
  tiers: [TierSchema],
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

ScoreTierConfigSchema.statics.getDefaultConfig = function(clientId) {
  return {
    clientId,
    isActive: true,
    tiers: [
      {
        score: 100,
        label: "VIP / High Value",
        conditions: [
          { assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 3 }
        ]
      },
      {
        score: 80,
        label: "Frequent Buyer",
        conditions: [
          { assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 1 }
        ]
      },
      {
        score: 60,
        label: "Active Cart / Checkout",
        conditions: [
          { assetId: 'CHECKOUT_COUNT', operator: '>=', targetValue: 1 }
        ]
      },
      {
        score: 40,
        label: "Engaged Prospect",
        conditions: [
          { assetId: 'INBOUND_MSG_COUNT', operator: '>=', targetValue: 5 }
        ]
      },
      {
        score: 20,
        label: "New Lead",
        conditions: [
          { assetId: 'TOTAL_ORDERS', operator: '==', targetValue: 0 }
        ]
      }
    ]
  };
};

module.exports = mongoose.model('ScoreTierConfig', ScoreTierConfigSchema);
