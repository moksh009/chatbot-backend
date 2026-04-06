const mongoose = require('mongoose');

const CustomerWalletSchema = new mongoose.Schema({
  customerId: String, // Internal lead ID or CRM ID
  phone: { type: String, required: true },
  clientId: { type: String, required: true },
  
  balance: { type: Number, default: 0 },
  lifetimePoints: { type: Number, default: 0 },
  
  tier: { 
    type: String, 
    enum: ['Bronze', 'Silver', 'Gold', 'Platinum'], 
    default: 'Bronze' 
  },

  transactions: [{
    type: { type: String, enum: ['earn', 'redeem', 'expired', 'adjustment'] },
    amount: Number,
    reason: String,
    orderId: String,
    timestamp: { type: Date, default: Date.now }
  }],

  updatedAt: { type: Date, default: Date.now }
});

// Index for fast lookups during chat sessions
CustomerWalletSchema.index({ phone: 1, clientId: 1 }, { unique: true });

module.exports = mongoose.model('CustomerWallet', CustomerWalletSchema);
