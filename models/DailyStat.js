const mongoose = require('mongoose');

const DailyStatSchema = new mongoose.Schema({
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  date: { type: String, required: true }, // YYYY-MM-DD
  totalChats: { type: Number, default: 0 },
  uniqueUsers: { type: Number, default: 0 },
  appointmentsBooked: { type: Number, default: 0 },
  birthdayRemindersSent: { type: Number, default: 0 },
  appointmentRemindersSent: { type: Number, default: 0 },
  totalMessagesExchanged: { type: Number, default: 0 },
  agentRequests: { type: Number, default: 0 },
  linkClicks: { type: Number, default: 0 },
  abandonedCartSent: { type: Number, default: 0 },
  abandonedCartClicks: { type: Number, default: 0 },
  cartRecoveryMessagesSent: { type: Number, default: 0 },
  cartsRecovered: { type: Number, default: 0 },
  recoveredViaStep1: { type: Number, default: 0 },
  recoveredViaStep2: { type: Number, default: 0 },
  recoveredViaStep3: { type: Number, default: 0 },
  cartRevenueRecovered: { type: Number, default: 0 },
  codConvertedCount: { type: Number, default: 0 },
  codConvertedRevenue: { type: Number, default: 0 },
  codNudgesSent: { type: Number, default: 0 },
  rtoCostSaved: { type: Number, default: 0 },
  reviewsCollected: { type: Number, default: 0 },
  marketingMessagesSent: { type: Number, default: 0 },
  marketingSummary: { type: Object, default: {} },
  reviewsPositive: { type: Number, default: 0 },
  reviewsNegative: { type: Number, default: 0 },
  // Phase 9 Service ROI
  bookingsCompleted:     { type: Number, default: 0 },
  bookingRevenue:        { type: Number, default: 0 },
  appointmentsCancelled: { type: Number, default: 0 },
  orders:                { type: Number, default: 0 },
  revenue:               { type: Number, default: 0 },
  
  // Phase 11: Hyper-Ecommerce KPIs
  browseAbandonedCount:  { type: Number, default: 0 },
  upsellSentCount:       { type: Number, default: 0 },
  upsellConvertedCount:  { type: Number, default: 0 },
  upsellRevenue:         { type: Number, default: 0 },
  abandonedProducts:      { type: Map, of: Number, default: {} }, // { "product_id": count }
  
  // Phase 23: Track 5 - WhatsApp Flows
  flowsSent:              { type: Number, default: 0 },
  flowsCompleted:         { type: Number, default: 0 }
});

// Ensure unique stats per client per day
DailyStatSchema.index({ clientId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyStat', DailyStatSchema);
