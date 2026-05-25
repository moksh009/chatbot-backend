const mongoose = require('mongoose');

const CampaignMessageSchema = new mongoose.Schema({
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    required: true,
    index: true
  },
  clientId: {
    type: String,
    required: true,
    index: true
  },
  phone: {
    type: String,
    required: true,
    index: true
  },
  messageId: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  status: {
    type: String,
    enum: ['queued', 'processing', 'retrying', 'sent', 'delivered', 'read', 'replied', 'failed', 'cancelled'],
    default: 'queued',
    index: true
  },
  variantId: { type: String, index: true },
  lockedBy: { type: String, default: null },
  lockedAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  lastAttemptAt: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: null },
  scheduledSendAt: { type: Date, default: null },
  failureReason: { type: String, default: null },
  recoveredFromDuplicate: { type: Boolean, default: false },
  cancelledReason: String,
  cancelledAt: Date,
  errorMessage: String,
  sentAt: Date,
  deliveredAt: Date,
  readAt: Date,
  repliedAt: Date,
  failedAt: Date,
  abVariantLabel: { type: String }, // "A" or "B" if this was part of an A/B test
  metadata: {
    type: Object,
    default: {}
  }
});

CampaignMessageSchema.index({ clientId: 1, status: 1, lockedAt: 1 });
CampaignMessageSchema.index({ campaignId: 1, status: 1 });

module.exports = mongoose.model('CampaignMessage', CampaignMessageSchema);
