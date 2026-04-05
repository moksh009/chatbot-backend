const mongoose = require('mongoose');

const webhookConfigSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  name:     { type: String, required: true, trim: true },
  url:      { type: String, required: true, trim: true },
  events:   [{ type: String }],
  isActive: { type: Boolean, default: true },
  secret:   { type: String, required: true }, // HMAC signing secret (shown once)

  customHeaders: [{
    key:   { type: String },
    value: { type: String }
  }],

  // Conditional filters — only fire if conditions pass
  filters: [{
    field:    { type: String }, // e.g. 'lead.leadScore'
    operator: { type: String }, // 'gt', 'lt', 'eq', 'contains'
    value:    { type: String }
  }],

  // Delivery stats
  lastFiredAt: { type: Date },
  totalFired:  { type: Number, default: 0 },
  lastStatus:  { type: Number }, // HTTP status of last delivery
  lastError:   { type: String },

  createdAt: { type: Date, default: Date.now }
});

webhookConfigSchema.index({ clientId: 1, events: 1 });

module.exports = mongoose.model('WebhookConfig', webhookConfigSchema);
