const mongoose = require('mongoose');

const CartRecoveryAttemptSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  contactPhone: { type: String, required: true },
  attemptTimestamp: { type: Date, default: Date.now },
  messaged: { type: Boolean, default: false },
  recovered: { type: Boolean, default: false },
  status: { type: String, enum: ['pending', 'recovered', 'expired'], default: 'pending' },
  recoveredOrderId: { type: String, default: null },
  recoveredOrderAmount: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

CartRecoveryAttemptSchema.index({ clientId: 1, contactPhone: 1, status: 1 });
CartRecoveryAttemptSchema.index({ clientId: 1, attemptTimestamp: 1 });
CartRecoveryAttemptSchema.index({ clientId: 1, status: 1 });

module.exports = mongoose.model('CartRecoveryAttempt', CartRecoveryAttemptSchema);
