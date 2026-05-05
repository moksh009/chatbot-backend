const mongoose = require('mongoose');

const supportChatSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  clientName: { type: String, required: true },
  requesterUserId: { type: String, default: '' },
  requesterEmail: { type: String, default: '' },
  requesterName: { type: String, default: '' },
  messages: [{
    sender: { type: String, enum: ['user', 'ai', 'admin'], required: true },
    text: { type: String, required: true },
    imageUrl: { type: String, default: '' },
    mimeType: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
    delivery: {
      channel: { type: String, enum: ['chat', 'email', 'chat+email'], default: 'chat' },
      status: { type: String, enum: ['pending', 'sent', 'failed', 'skipped'], default: 'sent' },
      deliveryAt: { type: Date, default: null },
      messageId: { type: String, default: '' },
      error: { type: String, default: '' }
    }
  }],
  status: { type: String, enum: ['active', 'human_requested', 'human_takeover', 'resolved'], default: 'active' },
  lastMessageAt: { type: Date, default: Date.now },
  hasUnreadAdmin: { type: Boolean, default: false },
  hasUnreadUser: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('SupportChat', supportChatSchema);
