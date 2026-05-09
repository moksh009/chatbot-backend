const mongoose = require('mongoose');

/**
 * UnrecognizedPhrase Schema
 * Captures user messages that the NLP engine failed to classify with high confidence.
 * This collection powers the 'Training Inbox' for manual model improvement.
 */
const unrecognizedPhraseSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  phrase: {
    type: String,
    required: true,
    trim: true
  },
  language: {
    type: String,
    default: 'unknown'
  },
  phoneNumber: {
    type: String,
    default: ''
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    default: null,
    index: true
  },
  source: {
    type: String,
    enum: ['LIVE_CHAT', 'SIMULATOR', 'WHATSAPP'],
    default: 'LIVE_CHAT'
  },
  status: {
    type: String,
    enum: ['PENDING', 'RESOLVED', 'IGNORED'],
    default: 'PENDING',
    index: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('UnrecognizedPhrase', unrecognizedPhraseSchema);
