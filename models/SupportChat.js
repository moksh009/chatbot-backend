const mongoose = require('mongoose');

const supportChatSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  clientName: { type: String, required: true },
  messages: [{
    sender: { type: String, enum: ['user', 'ai', 'admin'], required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
  }],
  status: { type: String, enum: ['active', 'human_requested', 'resolved'], default: 'active' },
  lastMessageAt: { type: Date, default: Date.now },
  hasUnreadAdmin: { type: Boolean, default: false },
  hasUnreadUser: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('SupportChat', supportChatSchema);
