const mongoose = require('mongoose');

const botAnalyticsSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  phoneNumber: String,
  event: {
    type: String,
    required: true,
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

module.exports = mongoose.model('BotAnalytics', botAnalyticsSchema);
