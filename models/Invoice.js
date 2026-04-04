const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  subscriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subscription',
    required: true
  },
  razorpayPaymentId: {
    type: String
  },
  amount: {
    type: Number, // in paise
    required: true
  },
  status: {
    type: String,
    enum: ['paid', 'failed', 'pending'],
    default: 'pending'
  },
  paidAt: {
    type: Date
  },
  invoiceUrl: {
    type: String // Razorpay invoice URL
  },
  period: {
    start: { type: Date },
    end: { type: Date }
  }
}, {
  timestamps: true
});

invoiceSchema.index({ clientId: 1 });
invoiceSchema.index({ subscriptionId: 1 });

module.exports = mongoose.model('Invoice', invoiceSchema);
