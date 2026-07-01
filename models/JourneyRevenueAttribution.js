const mongoose = require('mongoose');

const JourneyRevenueAttributionSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    orderKey: { type: String, required: true },
    shopifyOrderId: { type: String, default: '' },
    sourceFlowId: { type: String, required: true, index: true },
    sequenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FollowUpSequence',
      default: null,
      index: true,
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdLead',
      default: null,
    },
    phone: { type: String, default: '', index: true },
    amount: { type: Number, required: true, default: 0 },
    currency: { type: String, default: 'INR' },
    lastMessageSentAt: { type: Date, default: null },
    attributedAt: { type: Date, default: Date.now, index: true },
    attributionWindowHours: { type: Number, default: 168 },
    channel: { type: String, enum: ['whatsapp', 'email'], default: 'whatsapp' },
    journeyType: { type: String, default: '' },
    source: { type: String, default: 'shopify_webhook' },
    // clickDriven: true when there is evidence the customer tapped a tracked link
    // before purchasing (stronger attribution signal).  false = probable (message
    // was sent/delivered within the window but no click was recorded).
    clickDriven: { type: Boolean, default: false },
    // attributionWindowDays: per-journey override for the attribution window.
    // Default 30 days (= 720 hours). Set via WhatsAppFlow.journeyPolicies.attributionWindowDays.
    attributionWindowDays: { type: Number, default: 30 },
  },
  { timestamps: true }
);

JourneyRevenueAttributionSchema.index({ clientId: 1, orderKey: 1 }, { unique: true });
JourneyRevenueAttributionSchema.index({ clientId: 1, sourceFlowId: 1, attributedAt: -1 });
JourneyRevenueAttributionSchema.index({ clientId: 1, journeyType: 1, attributedAt: -1 });

module.exports = mongoose.model('JourneyRevenueAttribution', JourneyRevenueAttributionSchema);
