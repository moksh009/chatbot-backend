const mongoose = require('mongoose');

const CampaignRevenueAttributionSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    orderKey: { type: String, required: true },
    orderId: { type: String, default: '' },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: true,
      index: true,
    },
    phone: { type: String, default: '', index: true },
    amount: { type: Number, required: true, default: 0 },
    attributedAt: { type: Date, default: Date.now, index: true },
    lastMessageSentAt: { type: Date, default: null },
    source: { type: String, default: 'shopify_webhook' },
  },
  { timestamps: true }
);

CampaignRevenueAttributionSchema.index({ clientId: 1, orderKey: 1 }, { unique: true });
CampaignRevenueAttributionSchema.index({ clientId: 1, campaignId: 1, attributedAt: -1 });

module.exports = mongoose.model('CampaignRevenueAttribution', CampaignRevenueAttributionSchema);
