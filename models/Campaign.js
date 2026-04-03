const mongoose = require('mongoose');

const CampaignSchema = new mongoose.Schema({
  name: { type: String, required: true },
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  templateName: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['DRAFT', 'SCHEDULED', 'SENDING', 'COMPLETED', 'FAILED'], 
    default: 'DRAFT' 
  },
  scheduledAt: { type: Date },
  csvFile: { type: String }, // Path to uploaded CSV
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
  abVariants: [{
    label: String, // "A" or "B"
    templateId: String,
    recipients: [String],
    sentCount: { type: Number, default: 0 },
    readCount: { type: Number, default: 0 },
    repliedCount: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 }
  }],
  winnerVariant: String,

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Campaign', CampaignSchema);
