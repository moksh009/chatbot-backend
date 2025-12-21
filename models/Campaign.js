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
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Campaign', CampaignSchema);
