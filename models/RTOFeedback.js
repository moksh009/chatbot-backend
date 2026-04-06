const mongoose = require('mongoose');

/**
 * RTOFeedback — Training data for ML-based RTO risk predictor.
 * Created when an order is scored. actuallyReturned is updated
 * when Shopify marks the order as returned/refunded.
 */
const RTOFeedbackSchema = new mongoose.Schema({
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  phone:    { type: String, required: true },
  orderId:  { type: String, required: true },

  features: {
    isFirstOrder:       { type: Boolean, default: false },
    isCOD:              { type: Boolean, default: false },
    prevRTOCount:       { type: Number, default: 0 },
    leadScore:          { type: Number, default: 0 },
    msgCountBefore:     { type: Number, default: 0 },
    cartToOrderMinutes: { type: Number, default: 0 },
    orderValue:         { type: Number, default: 0 },
    prevOrders:         { type: Number, default: 0 },
    campaignIgnored:    { type: Number, default: 0 }, // unread campaigns last 30 days
    hourOfOrder:        { type: Number, default: 12 } // 0–23 IST
  },

  riskScoreAtTime: { type: Number, default: 0 },           // score when order was placed
  actuallyReturned: { type: Boolean, default: false },       // ground truth (Shopify webhook)
  method:           { type: String, default: 'rules' },      // "rules" | "ml_enhanced"

  createdAt: { type: Date, default: Date.now }
});

RTOFeedbackSchema.index({ clientId: 1, actuallyReturned: 1 });
RTOFeedbackSchema.index({ clientId: 1, orderId: 1 }, { unique: true });

module.exports = mongoose.model('RTOFeedback', RTOFeedbackSchema);
