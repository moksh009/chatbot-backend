const mongoose = require('mongoose');

const CampaignSchema = new mongoose.Schema({
  name: { type: String, required: true },
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  templateName: { type: String, default: "" },
  status: { 
    type: String, 
    enum: ['DRAFT', 'SCHEDULED', 'SENDING', 'COMPLETED', 'FAILED'], 
    default: 'DRAFT' 
  },
  scheduledAt: { type: Date },
  csvFile: { type: String }, // Path to uploaded CSV
  segmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Segment' },
  
  // Phase 22: Smart Send logic
  isSmartSend: { type: Boolean, default: false },
  smartSendConfig: { type: mongoose.Schema.Types.Mixed },

  // Phase 28: Predictive Send (AI-timed delivery)
  isPredictiveSend: { type: Boolean, default: false },
  predictiveSendConfig: {
    enabled: { type: Boolean, default: false },
    windowHours: { type: Number, default: 24 }, // max delay window
    fallbackImmediate: { type: Boolean, default: true } // send now if no data
  },

  recipientCount:  { type: Number, default: 0 },
  sentCount:       { type: Number, default: 0 },
  deliveredCount:  { type: Number, default: 0 },
  readCount:       { type: Number, default: 0 },
  repliedCount:    { type: Number, default: 0 },
  failedCount:     { type: Number, default: 0 },
  processingCount: { type: Number, default: 0 },
  queuedCount:     { type: Number, default: 0 },
  websiteClicks:   { type: Number, default: 0 },
  revenueAttributed: { type: Number, default: 0 },
  
  channel:         { type: String, enum: ["whatsapp","sms"], default: "whatsapp" },
  templateCategory:{ type: String, default: "" },  // UTILITY | MARKETING
  autoPaused:      { type: Boolean, default: false },
  autoPausedReason:{ type: String, default: "" },

  attributedOrders: { type: Number, default: 0 },
  isAbTest: { type: Boolean, default: false },
  abTestConfig: {
    testSizePercentage: { type: Number, default: 20 }, // 20% sent initially, 80% holdback
    winnerMetric: { type: String, enum: ['read_rate', 'reply_rate', 'revenue'], default: 'reply_rate' },
    holdbackHours: { type: Number, default: 4 }, // Hours to wait before deciding winner
    autoSendWinner: { type: Boolean, default: true },
    holdbackProcessed: { type: Boolean, default: false }
  },
  abVariants: [{
    label: String, // e.g., "A" or "B"
    templateName: String,
    languageCode: { type: String, default: 'en' },
    recipientCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    deliveredCount: { type: Number, default: 0 },
    readCount: { type: Number, default: 0 },
    repliedCount: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 }
  }],
  winnerVariant: String,

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Campaign', CampaignSchema);
