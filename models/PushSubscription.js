const mongoose = require('mongoose');

/**
 * PushSubscription — Web Push API subscriptions per agent/device.
 * Created when a user clicks "Enable Desktop Notifications".
 * Expired subscriptions (410 from WA push) are auto-deleted.
 */
const PushSubscriptionSchema = new mongoose.Schema({
  clientId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  agentId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  endpoint:  { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth:   { type: String, required: true }
  },

  userAgent:  { type: String, default: '' },
  createdAt:  { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: Date.now }
});

PushSubscriptionSchema.index({ clientId: 1, agentId: 1 });

module.exports = mongoose.model('PushSubscription', PushSubscriptionSchema);
