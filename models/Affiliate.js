const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Affiliate — Partner who earns commissions for referrals.
 * Simpler than Reseller: no sub-account management, just a referral link.
 */
const AffiliateSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name:   { type: String, required: true },
  email:  { type: String, required: true },
  phone:  { type: String, default: '' },

  // Auto-generated: e.g. "TOPEDGE_SMIT8" (format: TOPEDGE_XXXX)
  affiliateCode: { type: String, unique: true, required: true },
  referralUrl:   { type: String, default: '' }, // set on save

  commissionType:   { type: String, enum: ['flat', 'recurring'], default: 'recurring' },
  flatAmount:       { type: Number, default: 500 },      // INR per first paid signup
  recurringPercent: { type: Number, default: 15 },        // % of plan fee for 12 months

  status: {
    type: String,
    enum: ['pending', 'active', 'paused', 'banned'],
    default: 'pending'
  },

  stats: {
    clicks:          { type: Number, default: 0 },
    signups:         { type: Number, default: 0 },
    paidConversions: { type: Number, default: 0 },
    totalEarned:     { type: Number, default: 0 },   // INR
    pendingPayout:   { type: Number, default: 0 },
    paidOut:         { type: Number, default: 0 }
  },

  bankDetails: {
    accountName:   { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    ifsc:          { type: String, default: '' },
    upiId:         { type: String, default: '' }
  },

  createdAt: { type: Date, default: Date.now }
});

// Auto-generate referral URL before save
AffiliateSchema.pre('save', function(next) {
  if (!this.affiliateCode) {
    // Generate: TOPEDGE_ + 6 random uppercase chars
    this.affiliateCode = `TOPEDGE_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }
  if (!this.referralUrl) {
    const base = process.env.APP_URL || 'https://app.topedgeai.com';
    this.referralUrl = `${base}/signup?ref=${this.affiliateCode}`;
  }
  next();
});

AffiliateSchema.index({ affiliateCode: 1 }, { unique: true });
AffiliateSchema.index({ email: 1 });

module.exports = mongoose.model('Affiliate', AffiliateSchema);
