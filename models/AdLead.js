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
  appointmentsBooked: {
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
});

// Compound index for clientId + phoneNumber to ensure uniqueness per client
adLeadSchema.index({ clientId: 1, phoneNumber: 1 }, { unique: true });

// Pre-save hook to calculate score and tags
adLeadSchema.pre('save', function(next) {
  let score = 0;
  
  // Base activity points
  score += (this.ordersCount || 0) * 50;
  score += (this.appointmentsBooked || 0) * 50; // Points for booking
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
  if (this.addToCartCount > 0 && !this.isOrderPlaced) tags.add('abandoned-cart');
  
  this.tags = Array.from(tags);
  
  next();
});

// Post-hook for findOneAndUpdate to ensure score is recalculated
adLeadSchema.post('findOneAndUpdate', async function(doc) {
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
