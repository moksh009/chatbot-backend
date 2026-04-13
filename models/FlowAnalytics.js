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
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, { timestamps: true });

// Compound index for heatmap aggregation
flowAnalyticsSchema.index({ clientId: 1, flowId: 1, nodeId: 1 });

module.exports = mongoose.model('FlowAnalytics', flowAnalyticsSchema);
