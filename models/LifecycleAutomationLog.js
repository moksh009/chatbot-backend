const mongoose = require('mongoose');

const LifecycleAutomationLogSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    clientName: { type: String, default: '' },
    automationType: {
      type: String,
      enum: ['welcome', 'billing_reminder', 'payment_success', 'review_14d'],
      required: true,
      index: true,
    },
    channel: { type: String, enum: ['email', 'whatsapp'], required: true, index: true },
    status: { type: String, enum: ['sent', 'skipped', 'failed'], required: true, index: true },
    reason: { type: String, default: '' },
    sentForKey: { type: String, default: '', index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

LifecycleAutomationLogSchema.index({ createdAt: -1, automationType: 1, status: 1 });

module.exports = mongoose.model('LifecycleAutomationLog', LifecycleAutomationLogSchema);
