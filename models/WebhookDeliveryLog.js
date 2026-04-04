const mongoose = require('mongoose');

const webhookDeliveryLogSchema = new mongoose.Schema({
  webhookConfigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WebhookConfig',
    required: true
  },
  event:        { type: String },
  status:       { type: Number, default: 0 }, // HTTP status or 0 if no response
  responseBody: { type: String },
  error:        { type: String },
  deliveredAt:  { type: Date, default: Date.now },
  attempt:      { type: Number, default: 1 },
  failed:       { type: Boolean, default: false }
});

webhookDeliveryLogSchema.index({ webhookConfigId: 1, deliveredAt: -1 });

module.exports = mongoose.model('WebhookDeliveryLog', webhookDeliveryLogSchema);
