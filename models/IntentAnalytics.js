const mongoose = require('mongoose');

const intentAnalyticsSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
    index: true
  },
  date: {
    type: String, // Format: YYYY-MM-DD
    required: true,
    index: true
  },
  totalMessagesProcessed: {
    type: Number,
    default: 0
  },
  intentsMatched: {
    type: Number,
    default: 0
  },
  fallbackCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Compound index for unique daily records per client
intentAnalyticsSchema.index({ clientId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('IntentAnalytics', intentAnalyticsSchema);
