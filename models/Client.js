const mongoose = require('mongoose');

const ClientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  name: { type: String },
  businessType: { 
    type: String, 
    enum: ['ecommerce', 'salon', 'turf', 'clinic', 'other'],
    default: 'other'
  },
  phoneNumberId: { type: String, required: true, unique: true },
  whatsappToken: { type: String }, // Store the client's specific WhatsApp token
  verifyToken: { type: String }, // Store the client's specific Webhook Verify Token
  googleCalendarId: { type: String }, // Store the client's specific Google Calendar ID
  openaiApiKey: { type: String }, // Store the client's specific OpenAI API Key
  config: { type: mongoose.Schema.Types.Mixed, default: {} }, // Flexible config for other settings
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Client', ClientSchema);

