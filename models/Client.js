const mongoose = require('mongoose');

const ClientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  name: { type: String },
  businessType: { 
    type: String, 
    enum: ['ecommerce', 'salon', 'turf', 'clinic', 'choice_salon', 'agency', 'other'],
    default: 'other'
  },
  niche: {
    type: String,
    enum: ['ecommerce', 'salon', 'clinic', 'turf', 'agency', 'other'],
    default: 'other'
  },
  plan: {
    type: String,
    enum: ['CX Agent (V1)', 'CX Agent (V2)'],
    default: 'CX Agent (V1)'
  },
  subscriptionPlan: {
    type: String,
    enum: ['v1', 'v2'],
    default: 'v2' // Deprecated, migrating to 'plan'
  },
  isGenericBot: { type: Boolean, default: false },
  phoneNumberId: { type: String, required: true },
  whatsappToken: { type: String }, // Store the client's specific WhatsApp token
  wabaId: { type: String }, // WhatsApp Business Account ID (Required for Templates)
  verifyToken: { type: String }, // Store the client's specific Webhook Verify Token
  googleCalendarId: { type: String }, // Store the client's specific Google Calendar ID
  openaiApiKey: { type: String }, // Store the client's specific OpenAI API Key
  emailUser: { type: String },  // Gmail address for email broadcasts
  emailAppPassword: { type: String },  // Gmail App Password (not the login password)
  config: { type: mongoose.Schema.Types.Mixed, default: {} }, // Flexible config for other settings
  nicheData: { type: mongoose.Schema.Types.Mixed, default: {} }, // Flexible config for generic niche bots
  flowData: { type: mongoose.Schema.Types.Mixed, default: {} }, // Flexible config for generic WhatsApp text flows
  
  // Phase 7 Added Fields
  razorpayKeyId: { type: String, default: "" },
  razorpaySecret: { type: String, default: "" },
  googleReviewUrl: { type: String, default: "" },
  adminPhone: { type: String, default: "" },
  shopDomain: { type: String, default: "" },
  shopifyAccessToken: { type: String, default: "" },
  shopifyWebhookSecret: { type: String, default: "" },
  
  messageTemplates: [{
    id: { type: String, required: true },
    name: { type: String, required: true },
    body: { type: String, required: true },
    buttons: [{
      id: String,
      label: String
    }],
    waitMinutes: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    lastEditedAt: Date
  }],
  
  automationFlows: [{
    id: { type: String },
    isActive: { type: Boolean, default: false },
    config: { type: mongoose.Schema.Types.Mixed, default: {} }
  }],
  
  // Phase 9 Visual Node Builder Fields
  flowNodes: [{ type: mongoose.Schema.Types.Mixed, default: [] }],
  flowEdges: [{ type: mongoose.Schema.Types.Mixed, default: [] }],
  
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Client', ClientSchema);

