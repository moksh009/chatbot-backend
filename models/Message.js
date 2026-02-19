const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
  from: { type: String, required: true },
  to: { type: String, required: true },
  content: { type: String, required: false },
  type: { type: String, required: true },
  direction: { type: String, enum: ['incoming', 'outgoing'], required: true },
  timestamp: { type: Date, default: Date.now },
  messageId: { type: String },
  status: { type: String, default: 'sent' },
  mediaUrl: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed }
});

module.exports = mongoose.model('Message', MessageSchema);
