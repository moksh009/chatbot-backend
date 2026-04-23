const mongoose = require('mongoose');

/**
 * StatCache — Pre-computed statistics per client.
 * 
 * Instead of running 17+ aggregation queries on every /realtime request,
 * this model stores pre-computed counters that are atomically incremented
 * on data-change events (webhooks, cron jobs, etc.).
 * 
 * Performance target: /realtime response < 50ms (was 15-30s).
 */
const StatCacheSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },

  // === All-Time Counters ===
  totalLeads:         { type: Number, default: 0 },
  totalOrders:        { type: Number, default: 0 },
  totalLinkClicks:    { type: Number, default: 0 },
  totalAddToCarts:    { type: Number, default: 0 },
  totalCheckouts:     { type: Number, default: 0 },
  abandonedCarts:     { type: Number, default: 0 },
  recoveredCarts:     { type: Number, default: 0 },
  totalConversations: { type: Number, default: 0 },

  // === Today Counters (reset at IST midnight via cron) ===
  leadsToday:         { type: Number, default: 0 },
  ordersToday:        { type: Number, default: 0 },
  revenueToday:       { type: Number, default: 0 },
  appointmentsToday:  { type: Number, default: 0 },
  appointmentRevenueToday: { type: Number, default: 0 },

  // === Aggregated Stats ===
  abandonedCartSent:    { type: Number, default: 0 },
  abandonedCartClicks:  { type: Number, default: 0 },
  whatsappRecoveriesPurchased: { type: Number, default: 0 },
  adminFollowupsPurchased:     { type: Number, default: 0 },

  // === Sentiment Distribution ===
  sentimentCounts: {
    Positive:   { type: Number, default: 0 },
    Neutral:    { type: Number, default: 0 },
    Negative:   { type: Number, default: 0 },
    Frustrated: { type: Number, default: 0 },
    Urgent:     { type: Number, default: 0 },
    Unknown:    { type: Number, default: 0 }
  },

  // === Metadata ===
  lastRebuilt:  { type: Date, default: Date.now },
  todayResetAt: { type: Date, default: Date.now }
});

// Single lookup by clientId — unique index already handles this
StatCacheSchema.index({ clientId: 1 });

module.exports = mongoose.model('StatCache', StatCacheSchema);
