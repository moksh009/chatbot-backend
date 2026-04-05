const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  referrerLeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', required: true },
  referralCode: { type: String, required: true, unique: true },
  totalReferrals: { type: Number, default: 0 },
  successfulConversions: { type: Number, default: 0 },
  totalRewardsEarned: { type: Number, default: 0 }, // Value in INR/USD
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  history: [{
    referredLeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead' },
    status: { type: String, enum: ['clicked', 'joined', 'converted'] },
    rewardIssued: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Referral', referralSchema);
