const mongoose = require('mongoose');

const WhatsAppFlowSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  flowId: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  status: {
    type: String, // 'DRAFT', 'PUBLISHED', 'ARCHIVED'
    default: 'DRAFT'
  },
  version: {
    type: Number,
    default: 1
  },
  description: String,
  categories: [String],
  
  platform: {
    type: String,
    enum: ['whatsapp', 'instagram', 'omnichannel', 'meta'],
    default: 'whatsapp'
  },
  folderId: String,
  
  // Triggers Configuration
  triggerConfig: {
    type: {
      type: String, // 'KEYWORD', 'EVENT', 'AI_INTENT'
      default: 'KEYWORD'
    },
    keywords: [String],
    event: String, // 'order.placed', 'cart.abandoned', etc.
    intentId: String,
    skuMatches: [String] // Specific SKUs to trigger for
  },

  // State Management
  nodes: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  edges: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  publishedNodes: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  publishedEdges: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },

  validationErrors: [mongoose.Schema.Types.Mixed],
  lastSyncedAt: {
    type: Date,
    default: Date.now
  },
  /** Phase 9: post-purchase journey playbooks; Phase 1 Journey Builder: `journey` */
  flowType: {
    type: String,
    enum: ['standard', 'post_purchase_journey', 'journey'],
    default: 'standard',
  },
  playbookKey: { type: String, default: '' },
  /** PPJ: string enum; Journey Builder: `{ type, filters }` object — Mixed for backward compat */
  journeyTrigger: {
    type: mongoose.Schema.Types.Mixed,
    default: '',
  },
  journeyPolicies: {
    repeatPerCustomer: {
      type: String,
      enum: ['never', 'once_per_month', 'once_per_year'],
      default: 'never',
    },
    minOrderValue: { type: Number, default: null },
    productInclusions: { type: [String], default: null },
    windowDays: { type: Number, default: 1 },
    cancelOnReply: { type: Boolean, default: true },
    exitTriggers: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    reentryCooldownDays: { type: Number, default: null },
    maxEnrollmentsPerLead: { type: Number, default: null },
  },
  publishedAt: { type: Date, default: null },
  lastPublishedAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true },
  statsCache: { type: mongoose.Schema.Types.Mixed, default: null },
  /** Wizard / commerce: isolated automation graphs (do not mix with main keyword flow). */
  isAutomation: { type: Boolean, default: false },
  automationTrigger: { type: String, default: '' },
  generatedBy: { type: String, default: '' },
  /** Unified canvas folder taxonomy version (editor-only layout). */
  layoutSpecVersion: { type: String, default: '' },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

WhatsAppFlowSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

WhatsAppFlowSchema.index({ clientId: 1, updatedAt: -1 });

module.exports = mongoose.model('WhatsAppFlow', WhatsAppFlowSchema);
