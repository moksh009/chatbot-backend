const mongoose = require('mongoose');

const ClientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true, trim: true },
  businessName: { 
    type: String, 
    required: true,
    default: function() { return this.clientId; } 
  },
  name: { type: String }, // Legacy alias for businessName
  isActive: { type: Boolean, default: true },
  tier: { 
    type: String, 
    enum: ['v1', 'v2'],
    default: 'v1'
  },
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
    default: 'CX Agent (V1)'
  },
  isGenericBot: { type: Boolean, default: false },
  isAIFallbackEnabled: { type: Boolean, default: true },
  phoneNumberId: { type: String, default: "" },
  whatsappToken: { type: String }, // Store the client's specific WhatsApp token
  wabaId: { type: String }, // WhatsApp Business Account ID (Required for Templates)
  verifyToken: { type: String }, // Store the client's specific Webhook Verify Token
  googleCalendarId: { type: String }, // Store the client's specific Google Calendar ID
  geminiApiKey: { type: String }, // Store the client's specific Gemini API Key
  openaiApiKey: { type: String }, // Legacy field (aliased to geminiApiKey in middleware)
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
  shopifyRefreshToken: { type: String, default: "" },
  shopifyTokenExpiresAt: { type: Date },
  shopifyScopes: { type: String, default: "" },
  shopifyWebhookSecret: { type: String, default: "" },
  shopifyClientId: { type: String, default: "" },
  shopifyClientSecret: { type: String, default: "" },
  shopifyApiVersion: { type: String, default: "2024-01" },
  shopifyConnectionStatus: { type: String, enum: ['connected', 'error', 'disconnected'], default: 'connected' },
  lastShopifyError: { type: String, default: "" },
  generatedDiscounts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  aiUseGeneratedDiscounts: { type: Boolean, default: false }, // AI uses latest generated discount code when true
  
  // Phase 14 Multi-Gateway Support
  activePaymentGateway: { 
    type: String, 
    enum: ['cashfree', 'razorpay', 'none'], 
    default: 'none' 
  },
  cashfreeAppId: { type: String, default: "" },
  cashfreeSecretKey: { type: String, default: "" },
  
  // Phase 13 Store & Instagram Integration
  storeType: {
    type: String,
    enum: ["shopify", "woocommerce", "manual"],
    default: "shopify"
  },
  woocommerceUrl:    { type: String, default: "" },
  woocommerceKey:    { type: String, default: "" },
  woocommerceSecret: { type: String, default: "" },
  
  instagramPageId:      { type: String, default: "" },
  instagramAccessToken: { type: String, default: "" },
  instagramAppSecret:   { type: String, default: "" },
  instagramConnected:   { type: Boolean, default: false },
  
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
  
  // Phase 15 Visual Builder Multi-Flow Architecture
  flowFolders: { type: [mongoose.Schema.Types.Mixed], default: [] }, // { id: String, name: String, createdAt: Date }
  visualFlows: { type: [mongoose.Schema.Types.Mixed], default: [] }, // { id: String, name: String, folderId: String, platform: String, isActive: Boolean, nodes: [], edges: [], createdAt: Date, updatedAt: Date }

  
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
    type: { type: String },
    message: String,
    actionUrl: String,
    estimatedValue: Number,
    generatedAt: Date
  }],

  // Phase 18: AI Log
  unansweredQuestions: [{
    question: String,
    phone: String,
    aiResponse: String,
    askedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['pending', 'resolved'], default: 'pending' }
  }],

  // Phase 15 Trial & Admin Flags
  trialActive:   { type: Boolean, default: true },
  trialEndsAt:   { type: Date,    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }, // 7 days
  isPaidAccount: { type: Boolean, default: false },
  suspendedAt:   { type: Date },

  // Phase 17 Usage Tracking
  usage: {
    month:            { type: String, default: () => new Date().toISOString().slice(0, 7) }, // "2026-03"
    messagesSent:     { type: Number, default: 0 },
    aiCallsMade:      { type: Number, default: 0 },
    campaignsSent:    { type: Number, default: 0 },
    leadsCreated:     { type: Number, default: 0 },
    lastResetAt:      { type: Date,   default: Date.now }
  },
  limits: {
    messagesPerMonth:  { type: Number, default: 1000 },
    campaignsPerMonth: { type: Number, default: 5 },
    aiCallsPerMonth:   { type: Number, default: 500 },
  },

  // Admin Alert Notifications
  adminAlertEmail:    { type: String, default: "" },
  adminAlertWhatsapp: { type: String, default: "" },
  metaAppId:          { type: String, default: "" },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Client', ClientSchema);

