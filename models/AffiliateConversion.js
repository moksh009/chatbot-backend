const mongoose = require('mongoose');

/**
 * AffiliateConversion — Individual commission event tied to a signup or payment.
 * Created when: (a) new client signs up with ref code, or (b) client makes a payment.
 * Status: pending → approved → paid  (admin manual approval + payout)
 * 12-month cap on recurring commissions is enforced at the service layer.
 */
const AffiliateConversionSchema = new mongoose.Schema({
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true },
  clientId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Client',    required: true },

  conversionType: {
    type: String,
    enum: ['signup', 'payment'],
    required: true
  },

  amount: { type: Number, default: 0 },  // Commission in INR

  status: {
    type: String,
    enum: ['pending', 'approved', 'paid'],
    default: 'pending'
  },

  razorpayPaymentId: { type: String, default: '' }, // payment that triggered this
  payoutReference:   { type: String, default: '' }, // bank transfer / UPI ref
  notes:             { type: String, default: '' },

  createdAt: { type: Date, default: Date.now },
  approvedAt:{ type: Date },
  paidAt:    { type: Date }
});

AffiliateConversionSchema.index({ affiliateId: 1, status: 1 });
AffiliateConversionSchema.index({ clientId: 1, conversionType: 1 });

module.exports = mongoose.model('AffiliateConversion', AffiliateConversionSchema);
