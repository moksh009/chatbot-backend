const mongoose = require('mongoose');

/**
 * IntentRule Schema
 * Stores the deterministic rules for intent classification and automated actions.
 */
const intentRuleSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  intentName: {
    type: String,
    required: true,
    trim: true
  },
  trainingPhrases: {
    type: [String],
    default: []
  },
  antiIntentPhrases: {
    type: [String],
    default: []
  },
  languageConfig: {
    type: [String],
    default: ['en', 'hi']
  },
  actions: [{
    actionType: {
      type: String,
      enum: ['TAG_CHAT', 'ASSIGN_AGENT', 'SEND_TEMPLATE', 'PAUSE_BOT', 'NOTIFY_TEAM', 'TRIGGER_FLOW', 'ENROLL_SEQUENCE'],
      required: true
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    }
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  lastTriggeredAt: {
    type: Date,
    default: null
  },
  totalTriggerCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Compound index for unique intent names per client
intentRuleSchema.index({ clientId: 1, intentName: 1 }, { unique: true });

module.exports = mongoose.model('IntentRule', intentRuleSchema);
