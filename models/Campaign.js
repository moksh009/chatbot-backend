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
  stats: {
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    read: { type: Number, default: 0 },
    replied: { type: Number, default: 0 },
    converted: { type: Number, default: 0 } // Appointment booked
  },
  audienceCount: { type: Number, default: 0 },
  csvFile: { type: String }, // Path to uploaded CSV
  
  // Phase 11 & 21 Fields
  sentCount:      { type: Number, default: 0 },
  deliveredCount: { type: Number, default: 0 },
  readCount:      { type: Number, default: 0 },
  repliedCount:   { type: Number, default: 0 },
  failedCount:    { type: Number, default: 0 },
  totalAudience:  { type: Number, default: 0 },
  
  attributedRevenue: { type: Number, default: 0 },
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
