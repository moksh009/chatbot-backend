const mongoose = require('mongoose');

const LoyaltyTransactionSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  phone: { type: String, required: true },
  orderId: { type: String },
  type: { type: String, enum: ['earn', 'redeem', 'manual', 'deduct', 'backfill', 'adjust'], required: true },
  amount: { type: Number, required: true },
  reason: { type: String },
  balanceAfter: { type: Number },
  timestamp: { type: Date, default: Date.now }
});

LoyaltyTransactionSchema.index({ clientId: 1, phone: 1, type: 1, orderId: 1 });

module.exports = mongoose.model('LoyaltyTransaction', LoyaltyTransactionSchema);
