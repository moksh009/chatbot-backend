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
    type: String, // 'DRAFT', 'PUBLISHED', 'DEPRECATED'
    default: 'DRAFT'
  },
  categories: [String],
  validationErrors: [mongoose.Schema.Types.Mixed],
  lastSyncedAt: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('WhatsAppFlow', WhatsAppFlowSchema);
