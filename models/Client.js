const mongoose = require('mongoose');

const ClientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  name: { type: String },
  businessType: { 
    type: String, 
    enum: ['ecommerce', 'salon', 'turf', 'clinic', 'choice_salon', 'choice_salon_new', 'agency', 'other'],
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
  isAIFallbackEnabled: { type: Boolean, default: true },
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
  shopifyClientId: { type: String, default: "" },
  shopifyClientSecret: { type: String, default: "" },
  
  // messageTemplates stored as flexible Mixed array to support both 
  // legacy sub-documents and new flow-based template references
  messageTemplates: { type: mongoose.Schema.Types.Mixed, default: [] },
  
  automationFlows: [{
    id: { type: String },
    isActive: { type: Boolean, default: false },
    config: { type: mongoose.Schema.Types.Mixed, default: {} }
  }],
  
  // Phase 9 Visual Node Builder Fields
  flowNodes: { type: [mongoose.Schema.Types.Mixed], default: [] },
  flowEdges: { type: [mongoose.Schema.Types.Mixed], default: [] },
  
  // Phase 9 AI & Settings
  systemPrompt: { type: String, default: '' },
  syncedMetaTemplates: { type: mongoose.Schema.Types.Mixed, default: [] },
  syncedMetaFlows: { type: mongoose.Schema.Types.Mixed, default: [] },

  // Phase 9 Simple Settings Fallback (Priority 2 keywords)
  simpleSettings: {
    type: mongoose.Schema.Types.Mixed,
    default: {
      keywords: [
        { word: 'hi',     action: 'restart_flow'    },
        { word: 'hello',  action: 'restart_flow'    },
        { word: 'order',  action: 'track_order'     },
        { word: 'cancel', action: 'cancel_flow'     },
        { word: 'human',  action: 'escalate'        },
        { word: 'return', action: 'initiate_return' },
        { word: 'refund', action: 'initiate_return' }
      ],
      welcomeStartNodeId: '',
      storeUrl: '',
      knowledgeBase: '',
      variableMap: {
        'name':     'lead.name',
        'total':    'order.totalPrice',
        'product':  'cart.productName',
        'order_id': 'order.orderNumber',
        'date':     'appointment.date',
        'time':     'appointment.time',
        'service':  'appointment.serviceName'
      }
    }
  },

  // Phase 11 Added Fields
  quickReplies: [{ shortcut: String, message: String, category: String }],
  workingHours: {
    enabled: { type: Boolean, default: false },
    timezone: { type: String, default: "Asia/Kolkata" },
    hours: [{
      day: String,
      open: String,
      close: String,
      closed: Boolean
    }],
    afterHoursMessage: String
  },
  escalationRules: [{
    keywords: [String],
    action: String,
    notifyPhone: String
  }],
  knowledgeBase: {
    about: String,
    products: [{ name: String, price: Number, description: String, url: String }],
    faqs: [{ question: String, answer: String }],
    returnPolicy: String,
    shippingPolicy: String,
    contact: { phone: String, email: String, address: String },
    tone: String
  },
  flowHistory: [{
    version: Number,
    nodes: mongoose.Schema.Types.Mixed,
    edges: mongoose.Schema.Types.Mixed,
    savedAt: Date,
    note: String
  }],
  insights: [{
    type: String,
    message: String,
    actionUrl: String,
    estimatedValue: Number,
    generatedAt: Date
  }],

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Client', ClientSchema);

