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
  checkoutInitiatedCount: {
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
  appointmentsBooked: {
    type: Number,
    default: 0
  },
  activityLog: [{
    action: String, // 'link_click', 'add_to_cart', 'order_placed'
    details: String,
    timestamp: { type: Date, default: Date.now }
  }],
  cartSnapshot: {
    handles: [String],
    titles: [String],
    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  isOrderPlaced: {
    type: Boolean,
    default: false
  },
  cartStatus: {
    type: String,
    enum: ['active', 'abandoned', 'recovered', 'purchased'],
    default: 'active'
  },
  abandonedCartReminderSentAt: Date,
  abandonedCartRecoveredAt: Date,
  adminFollowUpTriggered: {
    type: Boolean,
    default: false
  },
  source: {
    type: String,
    default: 'Direct'
  },
  leadScore: {
    type: Number,
    default: 0
  },
  tags: [{
    type: String
  }],
  lastInteraction: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for derived Lead State
adLeadSchema.virtual('derivedLeadState').get(function () {
  // 1. Purchased Recently (<24h)
  if (this.cartStatus === 'purchased') {
    // Find last order timestamp in activityLog if available
    const orderLogs = this.activityLog?.filter(log => log.action === 'order_placed') || [];
    if (orderLogs.length > 0) {
      const lastOrderDate = new Date(orderLogs[orderLogs.length - 1].timestamp);
      const hoursSinceOrder = (new Date() - lastOrderDate) / (1000 * 60 * 60);
      if (hoursSinceOrder < 24) return 'Purchased Recently';
    } else {
      // Fallback: Use lastInteraction if cartStatus is purchased recently
      const hoursSinceInteraction = (new Date() - new Date(this.lastInteraction)) / (1000 * 60 * 60);
      if (hoursSinceInteraction < 24) return 'Purchased Recently';
    }
  }

  // 2. Recovered Cart
  if (this.cartStatus === 'recovered') return 'Recovered Cart';

  // 3. Cart Abandoned
  if (this.cartStatus === 'abandoned') return 'Cart Abandoned';

  // 4. High Intent (Checkout Started)
  if (this.checkoutInitiatedCount > 0 && !this.isOrderPlaced) return 'High Intent';

  // 5. Browsing with Intent
  if (this.addToCartCount > 0) return 'Browsing with Intent';

  // 6. Default
  return 'Browsing';
});

// Compound index for clientId + phoneNumber to ensure uniqueness per client
adLeadSchema.index({ clientId: 1, phoneNumber: 1 }, { unique: true });

// Pre-save hook to calculate score and tags
adLeadSchema.pre('save', function (next) {
  let score = 0;

  // Base activity points
  score += (this.ordersCount || 0) * 50;
  score += (this.appointmentsBooked || 0) * 50; // Points for booking
  score += (this.checkoutInitiatedCount || 0) * 30; // Points for checkout initiated
  score += (this.addToCartCount || 0) * 20;
  score += (this.linkClicks || 0) * 5;

  // Recency bonus (if interaction within last 7 days)
  const daysSinceLastInteraction = (new Date() - new Date(this.lastInteraction)) / (1000 * 60 * 60 * 24);
  if (daysSinceLastInteraction < 7) {
    score += 10;
  }

  this.leadScore = score;

  // Update Tags
  const tags = new Set(this.tags || []);
  if (this.ordersCount > 0) tags.add('customer');
  if (this.ordersCount > 3) tags.add('loyal');
  if (score > 100) tags.add('high-value');
  if (score > 50 && score <= 100) tags.add('warm');

  // Auto-manage new dynamic tags
  if (this.totalSpent > 0) tags.add('repeat-buyer');
  if (this.checkoutInitiatedCount >= 2) tags.add('high-intent');

  if (this.cartStatus === 'abandoned') {
    tags.add('cart-abandoned');
  } else if (this.cartStatus === 'recovered' || this.cartStatus === 'purchased') {
    tags.delete('cart-abandoned');
  }

  if (this.checkoutInitiatedCount > 0 && !this.isOrderPlaced) {
    tags.add('checkout-initiated');
  } else if (this.isOrderPlaced) {
    tags.delete('checkout-initiated');
  }

  this.tags = Array.from(tags);

  // Data Consistency Auto-Correction
  if (this.cartStatus === 'purchased' && this.cartSnapshot?.updatedAt) {
    const orderLogs = this.activityLog?.filter(log => log.action === 'order_placed') || [];
    if (orderLogs.length > 0) {
      const lastOrderDate = new Date(orderLogs[orderLogs.length - 1].timestamp);
      if (new Date(this.cartSnapshot.updatedAt) > lastOrderDate) {
        this.cartStatus = 'active'; // Cart was updated *after* the last purchase event
      }
    }
  }

  next();
});

// Post-hook for findOneAndUpdate to ensure score is recalculated
adLeadSchema.post('findOneAndUpdate', async function (doc) {
  if (doc) {
    // Re-fetch to ensure we have the latest data before saving (triggers pre-save score calculation)
    const latest = await doc.constructor.findById(doc._id);
    if (latest) {
      await latest.save();
    }
  }
});

const AdLead = mongoose.model('AdLead', adLeadSchema);

module.exports = AdLead;
