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
  },
  { timestamps: true }
);

JourneyRevenueAttributionSchema.index({ clientId: 1, orderKey: 1 }, { unique: true });
JourneyRevenueAttributionSchema.index({ clientId: 1, sourceFlowId: 1, attributedAt: -1 });

module.exports = mongoose.model('JourneyRevenueAttribution', JourneyRevenueAttributionSchema);
