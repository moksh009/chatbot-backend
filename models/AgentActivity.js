const mongoose = require('mongoose');

const AgentActivitySchema = new mongoose.Schema({
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientId: { type: String, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  
  // Metrics
  totalResponses: { type: Number, default: 0 },
  avgResponseTimeSec: { type: Number, default: 0 }, // In seconds
  resolvedCount: { type: Number, default: 0 },
  csatScores: [{ type: Number }], // Array of 1-5 ratings
  
  // Detailed Tracking
  activeTimeMinutes: { type: Number, default: 0 },
  conversationsHandled: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' }]
}, { timestamps: true });

// Ensure one record per agent per day
AgentActivitySchema.index({ agentId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('AgentActivity', AgentActivitySchema);
