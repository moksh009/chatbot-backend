const mongoose = require('mongoose');

const PeakHourSchema = new mongoose.Schema({
  hour: { type: Number, min: 0, max: 23 },
  interactionCount: { type: Number, default: 0 }
}, { _id: false });

const CustomerIntelligenceSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  phone: { type: String, required: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead' },
  
  // Behavioral Profiling (DNA)
  persona: { type: String, enum: ['value_shopper', 'impulse_buyer', 'vip', 'window_shopper', 'bargain_hunter', 'negotiator', 'unknown'], default: 'unknown' },
  sentimentTrend: { type: String, enum: ['improving', 'stable', 'declining'], default: 'stable' },
  preferredLanguage: { type: String, default: 'en' },
  avgMessageLength: { type: Number, default: 0 },
  emojiUsage: { type: Number, default: 0 }, // 0-1 frequency
  formality: { type: String, enum: ['formal', 'casual', 'not_enough_data'], default: 'not_enough_data' },
  
  // Temporal/Predictive
  peakInteractionHours: [PeakHourSchema], // e.g., [{ hour: 18, interactionCount: 12 }]
  avgResponseTimeMin: { type: Number, default: 0 },
  responseConsistency: { type: Number, default: 100 }, // 0-100 score
  optimalSendWindow: { 
    startHour: { type: Number, default: 9 }, 
    endHour: { type: Number, default: 20 } 
  },
  
  // Transactional DNA
  priceSensitivity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  decisionSpeed: { type: String, enum: ['fast', 'medium', 'slow'], default: 'medium' },
  negotiationStyle: { type: String, enum: ['aggressive', 'polite', 'none'], default: 'none' },
  negotiationCount: { type: Number, default: 0 },
  avgOrderValue: { type: Number, default: 0 },
  preferredPayment: { type: String, enum: ['cod', 'prepaid', 'unknown'], default: 'unknown' },
  
  // Campaign & Flow DNA
  opensCampaigns: { type: Number, default: 0 },
  clicksCampaignLinks: { type: Number, default: 0 },
  repliesToCampaigns: { type: Number, default: 0 },
  completesFlows: { type: Number, default: 0 },
  respondsToCTA: { type: Number, default: 0 },
  
  // Product Interest DNA
  categoryInterests: [String],
  viewedProductIds: [String],
  purchasedCategories: [String],

  // Lifecycle DNA
  lifetimeOrders: { type: Number, default: 0 },
  lifetimeValue: { type: Number, default: 0 },
  returnRate: { type: Number, default: 0 },
  
  // Scoring
  engagementScore: { type: Number, default: 10, min: 0, max: 100 },
  conversionProbability: { type: Number, default: 0 },
  churnRiskScore: { type: Number, default: 0, min: 0, max: 100 },
  
  // AI Synthesis
  lastSynthesisAt: { type: Date },
  aiSummary: { type: String, default: '' },
  personalizationHints: [String], // AI-generated tips for agents
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

CustomerIntelligenceSchema.index({ phone: 1, clientId: 1 }, { unique: true });

// Pre-save hook to determine optimal send window
CustomerIntelligenceSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  if (this.peakInteractionHours && this.peakInteractionHours.length > 0) {
    // Sort descending by interaction count
    const sorted = [...this.peakInteractionHours].sort((a, b) => b.interactionCount - a.interactionCount);
    const topHour = sorted[0].hour;
    
    // Set optimal window around peak hour
    this.optimalSendWindow.startHour = Math.max(0, topHour - 1);
    this.optimalSendWindow.endHour = Math.min(23, topHour + 1);
  }
  
  next();
});

module.exports = mongoose.model('CustomerIntelligence', CustomerIntelligenceSchema);
