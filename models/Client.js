const mongoose = require('mongoose');

const ClientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  name: { type: String },
  businessType: { 
    type: String, 
    enum: ['ecommerce', 'salon', 'turf', 'clinic', 'choice_salon', 'other'],
    default: 'other'
  },
  subscriptionPlan: {
    type: String,
    enum: ['v1', 'v2'],
    default: 'v2' // Defaulting to v2 for now to preserve existing functionality, migration script will handle specifics
  },
  phoneNumberId: { type: String, required: true }, // Removed unique: true to allow multiple clients (e.g. testing) on same number
  whatsappToken: { type: String }, // Store the client's specific WhatsApp token
  verifyToken: { type: String }, // Store the client's specific Webhook Verify Token
  googleCalendarId: { type: String }, // Store the client's specific Google Calendar ID
  openaiApiKey: { type: String }, // Store the client's specific OpenAI API Key
  config: { type: mongoose.Schema.Types.Mixed, default: {} }, // Flexible config for other settings
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Client', ClientSchema);

