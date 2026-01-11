const mongoose = require('mongoose');

const adLeadSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  phoneNumber: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    trim: true
  },
  chatSummary: {
    type: String,
    default: ''
  },
  linkClicks: {
    type: Number,
    default: 0
  },
  addToCartCount: {
    type: Number,
    default: 0
  },
  ordersCount: {
    type: Number,
    default: 0
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  activityLog: [{
    action: String, // 'link_click', 'add_to_cart', 'order_placed'
    details: String,
    timestamp: { type: Date, default: Date.now }
  }],
  isOrderPlaced: {
    type: Boolean,
    default: false
  },
  source: {
    type: String,
    default: 'Direct'
  },
  lastInteraction: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for clientId + phoneNumber to ensure uniqueness per client
adLeadSchema.index({ clientId: 1, phoneNumber: 1 }, { unique: true });

const AdLead = mongoose.model('AdLead', adLeadSchema);

module.exports = AdLead;
