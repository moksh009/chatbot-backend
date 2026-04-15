const mongoose = require('mongoose');

const flowAnalyticsSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  flowId: {
    type: String,
    index: true
  },
  nodeId: {
    type: String,
    required: true,
    index: true
  },
  nodeType: {
    type: String
  },
  phone: {
    type: String,
    index: true
  },
  // Enterprise Analytics Expansion
  duration: {
    type: Number, // Time spent in milliseconds (if applicable)
    default: 0
  },
  action: {
    type: String, // 'entry', 'dropoff', 'click', 'conversion'
    default: 'entry',
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, { timestamps: true });

// Compound index for heatmap and conversion funnel aggregation
flowAnalyticsSchema.index({ clientId: 1, flowId: 1, nodeId: 1, action: 1 });
flowAnalyticsSchema.index({ clientId: 1, action: 1, timestamp: -1 });

module.exports = mongoose.model('FlowAnalytics', flowAnalyticsSchema);
