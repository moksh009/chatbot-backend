const mongoose = require('mongoose');

const webhookDeliveryLogSchema = new mongoose.Schema({
  webhookConfigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WebhookConfig',
    required: true
  },
  clientId:     { type: String, index: true }, // Added for easy filtering
  event:        { type: String },
  status:       { type: Number, default: 0 },
  responseBody: { type: String },
  error:        { type: String },
  deliveredAt:  { type: Date, default: Date.now },
  attempt:      { type: Number, default: 1 },
  failed:       { type: Boolean, default: false },
  isDead:       { type: Boolean, default: false }, // Failed all retries
  replayed:     { type: Boolean, default: false }, // Manually re-triggered
  rawPayload:   { type: mongoose.Schema.Types.Mixed }, // Dead-Letter storage
  createdAt:    { type: Date, default: Date.now, expires: '30d' } // Auto-cleanup
});

webhookDeliveryLogSchema.index({ webhookConfigId: 1, deliveredAt: -1 });

module.exports = mongoose.model('WebhookDeliveryLog', webhookDeliveryLogSchema);
