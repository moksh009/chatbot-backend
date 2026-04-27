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
  sentimentScore: { type: Number, default: 0 },

  // Phase 28 Bidirectional Translation
  translatedContent: { type: String, default: '' },
  detectedLanguage: { type: String, default: 'en' },
  translations: { type: Map, of: String, default: {} }, // e.g., { 'es': 'Hola', 'hi': 'नमस्ते' }
  originalText: { type: String, default: '' } // Stores agent raw input before translation
});

// ✅ Phase R3: Performance indexes — conversationId+timestamp was missing, causing full-collection scans on Live Chat load
MessageSchema.index({ conversationId: 1, timestamp: -1 }); // Primary Live Chat history query
MessageSchema.index({ clientId: 1, timestamp: -1 });        // Analytics queries (messages per period)
MessageSchema.index({ messageId: 1 }, { unique: true, sparse: true });    // Webhook deduplication lookup

module.exports = mongoose.model('Message', MessageSchema);
