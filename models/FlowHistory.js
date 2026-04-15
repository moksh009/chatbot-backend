const mongoose = require('mongoose');

const FlowHistorySchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  flowId: {
    type: String,
    required: true,
    index: true
  },
  version: {
    type: Number,
    required: true
  },
  nodes: [mongoose.Schema.Types.Mixed],
  edges: [mongoose.Schema.Types.Mixed],
  publishedBy: String,
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, { timestamps: true });

// Compound index for fast retrieval of a specific flow's history
FlowHistorySchema.index({ clientId: 1, flowId: 1, version: -1 });

module.exports = mongoose.model('FlowHistory', FlowHistorySchema);
