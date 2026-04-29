const mongoose = require('mongoose');

const adLeadSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true
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
  isNameCustom: {
    type: Boolean,
    default: false
  },
  nameSource: {
    type: String,
    enum: ['imported', 'whatsapp', 'manual'],
    default: 'whatsapp'
  },
  importBatchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImportBatch',
    default: null,
    index: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
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
  // Layer 2: Loyalty Hub $unwind Killer (Pre-computed fields)
  loyaltyPoints: {
    type: Number,
    default: 0
  },
  pendingSupport: {
    type: Boolean,
    default: false
  },
  loyaltyTier: {
    type: String,
    default: 'Bronze'
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  appointmentsBooked: {
    type: Number,
    default: 0
  },
  rtoCount: {
    type: Number,
    default: 0
  },
  refundCount: {
    type: Number,
    default: 0
  },
  lastPurchaseDate: {
    type: Date,
    default: null
  },
  activityLog: [{
    action: String, // 'link_click', 'add_to_cart', 'order_placed'
    details: String,
    timestamp: { type: Date, default: Date.now }
  }],
  cartSnapshot: {
    handles: [String],
    titles: [String],
    items: [{
      variant_id: String,
      quantity: Number,
      image: String,
      url: String
    }],
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
    enum: ['active', 'abandoned', 'recovered', 'purchased', 'failed'],
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
  scoreLabel: {
    type: String,
    default: 'Cold Lead'
  },
  tags: [{
    type: String,
    index: true
  }],
  lastInteraction: {
    type: Date,
    default: Date.now
  },
  meta: {
    type: Object,
    default: {}
  },
  // Phase 9 fields
  intentState: {
    type: String,
    default: "Cold"
  },
  inboundMessageCount: {
    type: Number,
    default: 0
  },
  isRtoRisk: {
    type: Boolean,
    default: false
  },
  isTimeWaster: {
    type: Boolean,
    default: false
  },
  cartItems: { type: mongoose.Schema.Types.Mixed, default: [] },
  cartValue:  { type: Number, default: 0 },
  cartUrl:    { type: String, default: '' },
  cartAbandonedAt:   { type: Date },
  recoveryStep:      { type: Number },
  recoveryStartedAt: { type: Date },
  lastOrderId:    { type: String, default: '' },
  lifetimeValue:  { type: Number, default: 0 },
  birthday:       { type: Date,   default: null },
  birthdayMsgSent:{ type: Boolean,default: false },
  
  // Phase 3: Sales Velocity & CRM Alpha

  inboundIntent:   { type: String, default: 'neutral' }, // 'inquiry', 'purchase', 'complaint', 'support'
  lastScoredAt:    { type: Date },
  
  // Phase 21: Captured Variables Storage
  capturedData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  captureHistory: [{
    field:      String,
    value:      String,
    capturedAt: { type: Date, default: Date.now },
    flowNodeId: String
  }],

  // Phase 21: Opt Management & Attribution
  optStatus:        { type: String, enum: ["opted_in","opted_out","unknown"], default: "unknown" },
  optInDate:        { type: Date, default: null },
  optInSource:      { type: String, default: "" },  // "whatsapp_message" | "website_widget" | "qr_code" | "form" | "manual"
  optOutDate:       { type: Date, default: null },
  optOutReason:     { type: String, default: "" },  // "user_keyword" | "admin_removed" | "inactive"
  optOutKeyword:    { type: String, default: "" },  // the keyword they sent to opt out
  optInHistory: [{
    action:    String,   // "opted_in" | "opted_out" | "re_opted_in"
    timestamp: Date,
    source:    String,
    note:      String
  }],
  adAttribution: {
    source:         String,  // "meta_ad" | "instagram_ad" | "organic" | "direct"
    adId:           String,
    adSourceUrl:    String,
    adType:         String,
    adHeadline:     String,
    adBody:         String,
    adMediaUrl:     String,
    firstMessageAt: Date
  },
  commerceEvents: [{
    event:     String, // 'product_added_to_cart', 'checkout_started', 'checkout_completed'
    amount:    Number,
    currency:  String,
    timestamp: { type: Date, default: Date.now },
    metadata:  mongoose.Schema.Types.Mixed
  }],
  
  // Phase 25: Customer Journey Map
  journeyLog: [{
    eventName: String, // 'flow_started', 'campaign_opened', 'human_takeover', 'order_placed', 'booking_made'
    timestamp: { type: Date, default: Date.now },
    metadata: mongoose.Schema.Types.Mixed
  }],

  // Phase 25: Referral Tracking
  referralCode: String, // Code belonging to THIS lead
  referredBy: String,   // The code that brought THIS lead in
  
  // Phase 30.5: Enterprise Warranty Records
  warrantyRecords: [{
    orderId: String,
    serialNumber: String,
    productName: String,
    productImage: String,
    purchaseDate: { type: Date, default: Date.now },
    expiryDate: Date,
    status: { type: String, enum: ['active', 'expired', 'claimed'], default: 'active' },
  registeredAt: { type: Date, default: Date.now }
  }],

  // Phase 28: Live Activity Tracking
  lastMessageContent: { type: String, default: '' },
  lastInboundAt: { type: Date, default: null },

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

// ✅ Phase R3: Performance indexes — were missing, causing full-collection scans on dashboard queries
adLeadSchema.index({ clientId: 1, lastInteraction: -1 }); // Dashboard "Recent Activity" sorts
adLeadSchema.index({ clientId: 1, tags: 1 });              // Segment tag filtering queries
adLeadSchema.index({ clientId: 1, cartStatus: 1 });        // Abandoned cart recovery queries
adLeadSchema.index({ clientId: 1, leadScore: -1 });        // Lead scoring leaderboard queries
adLeadSchema.index({ clientId: 1, optStatus: 1 });         // Opt-in/out management queries

// Static Helper for Phase 25 Customer Journey Map
adLeadSchema.statics.pushJourneyEvent = async function(clientId, phoneNumber, eventName, metadata = {}) {
  try {
    await this.updateOne(
      { clientId, phoneNumber },
      { $push: { journeyLog: { eventName, timestamp: new Date(), metadata } } }
    );
  } catch (err) {
    console.error(`[AdLead] pushJourneyEvent failed for ${phoneNumber}:`, err.message);
  }
};

// Performance indexes for dashboard queries
adLeadSchema.index({ clientId: 1, createdAt: -1 });
adLeadSchema.index({ clientId: 1, _id: -1 });      // Default sort for paginated leads listing
// Note: { clientId: 1, cartStatus: 1 } and { clientId: 1, leadScore: -1 } already defined in Phase R3 block above

// Enterprise: Import rollback performance (deleteMany on meta.lastImportId)
adLeadSchema.index({ clientId: 1, 'meta.lastImportId': 1 });

// Performance Overhaul: Indexes for expensive aggregation pipelines
adLeadSchema.index({ clientId: 1, 'activityLog.action': 1, 'activityLog.timestamp': -1 }); // Chart $unwind queries on activityLog
adLeadSchema.index({ clientId: 1, isOrderPlaced: 1, recoveryStep: 1, updatedAt: -1 });     // Abandoned cart cron batch queries
adLeadSchema.index({ clientId: 1, adminFollowUpTriggered: 1, isOrderPlaced: 1 });           // Attribution funnel query

const AdLead = mongoose.model('AdLead', adLeadSchema);

module.exports = AdLead;
