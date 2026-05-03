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
  /** Wizard / commerce: isolated automation graphs (do not mix with main keyword flow). */
  isAutomation: { type: Boolean, default: false },
  automationTrigger: { type: String, default: '' },
  generatedBy: { type: String, default: '' },
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

module.exports = mongoose.model('WhatsAppFlow', WhatsAppFlowSchema);
