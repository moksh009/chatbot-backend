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
  metadata: { type: mongoose.Schema.Types.Mixed },
  
  // Phase 13 Omnichannel
  channel: {
    type: String,
    enum: ["whatsapp", "instagram", "email"],
    default: "whatsapp"
  },
  
  // Phase 14 Campaign Tracking
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },

  // Phase 25 Voice Note Transcriptions
  voiceTranscript: { type: String, default: '' },
  voiceTranslation: { type: String, default: '' },
  voiceProcessed: { type: Boolean, default: false },
  originalType: { type: String },

  // Phase 26 Sentiment Analysis
  sentiment: { type: String, enum: ['Positive', 'Neutral', 'Negative', 'Frustrated', 'Urgent', 'Unknown'], default: 'Unknown' },
  sentimentScore: { type: Number, default: 0 }
});

module.exports = mongoose.model('Message', MessageSchema);
