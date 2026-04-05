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
    enum: ['queued', 'sent', 'delivered', 'read', 'replied', 'failed'],
    default: 'queued',
    index: true
  },
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

module.exports = mongoose.model('CampaignMessage', CampaignMessageSchema);
