const mongoose = require('mongoose');

const WebhookErrorLogSchema = new mongoose.Schema({
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  error: { type: String, required: true },
  stack: { type: String },
  createdAt: { type: Date, default: Date.now }
});

// TTL index to automatically drop logs older than 7 days (604800 seconds)
WebhookErrorLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

module.exports = mongoose.model('WebhookErrorLog', WebhookErrorLogSchema);
