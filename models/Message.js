const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
  from: { type: String, required: true },
  to: { type: String, required: true },
  content: { type: String, required: false }, // Text content or button ID
  type: { type: String, required: true }, // 'text', 'interactive', 'image', 'template', etc.
  direction: { type: String, enum: ['incoming', 'outgoing'], required: true },
  timestamp: { type: Date, default: Date.now },
  messageId: { type: String }, // WhatsApp Message ID
  status: { type: String, default: 'sent' } // sent, delivered, read, failed (for outgoing)
});

module.exports = mongoose.model('Message', MessageSchema);
