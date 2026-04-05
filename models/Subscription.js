const mongoose = require('mongoose');

const usageSchema = new mongoose.Schema({
  contacts: { type: Number, default: 0 },
  messages: { type: Number, default: 0 },
  campaigns: { type: Number, default: 0 },
  aiCallsMade: { type: Number, default: 0 }
}, { _id: false });

const subscriptionSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
    unique: true
  },
  plan: {
    type: String,
    enum: ['starter', 'growth', 'enterprise', 'trial'],
    required: true,
    default: 'trial'
  },
  status: {
    type: String,
    enum: ['active', 'past_due', 'cancelled', 'trial', 'pending', 'frozen'],
    required: true,
    default: 'trial'
  },
  billingCycle: {
    type: String,
    enum: ['monthly', 'annual', 'none'],
    default: 'monthly'
  },
  amount: {
    type: Number, // in paise
    default: 0
  },
  currency: {
    type: String,
    default: 'INR'
  },
  
  razorpaySubId: { type: String },
  razorpayCustomerId: { type: String },
  
  trialStartedAt: { type: Date },
  trialEndsAt: { type: Date },
  
  currentPeriodStart: { type: Date },
  currentPeriodEnd: { type: Date },
  
  usageThisPeriod: {
    type: usageSchema,
    default: () => ({})
  },
  
  cancelledAt: { type: Date },
  cancelReason: { type: String }
}, {
  timestamps: true
});

subscriptionSchema.index({ status: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
