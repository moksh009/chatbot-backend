const mongoose = require('mongoose');
const { encrypt } = require('../utils/encryption');

// --- TIER 2.5 SUB-DOCUMENT SCHEMAS ---

const BrandSchema = new mongoose.Schema({
  businessName: { type: String, default: "" },
  niche: { type: String, default: "other" },
  businessType: { type: String, default: "other" },
  adminPhone: { type: String, default: "" },
  googleReviewUrl: { type: String, default: "" },
  // Enterprise Warranty
  warrantyDefaultDuration: { type: String, default: "1 Year" },
  warrantySupportPhone: { type: String, default: "" },
  warrantyClaimUrl: { type: String, default: "" },
  warrantyEmailEnabled: { type: Boolean, default: false },
  warrantyWhatsappEnabled: { type: Boolean, default: false },
  productWarranties: { type: mongoose.Schema.Types.Mixed, default: {} } // SKU -> Duration
}, { _id: false });

const WhatsappSchema = new mongoose.Schema({
  phoneNumberId: { type: String, default: "" },
  wabaId: { type: String, default: "" },
  accessToken: { type: String, default: "" }, 
  verifyToken: { type: String, default: "" }
}, { _id: false });

const CommerceShopifySchema = new mongoose.Schema({
  domain: { type: String, default: "" },
  accessToken: { type: String, default: "" }, 
  refreshToken: { type: String, default: "" }, 
  clientId: { type: String, default: "" },
  clientSecret: { type: String, default: "" }, 
  webhookSecret: { type: String, default: "" } 
}, { _id: false });

const CommerceWooCommerceSchema = new mongoose.Schema({
  url: { type: String, default: "" },
  key: { type: String, default: "" }, 
  secret: { type: String, default: "" }, 
  webhookSecret: { type: String, default: "" } 
}, { _id: false });

const CommerceSchema = new mongoose.Schema({
  storeType: { type: String, enum: ["shopify", "woocommerce", "manual"], default: "shopify" },
  shopify: { type: CommerceShopifySchema, default: () => ({}) },
  woocommerce: { type: CommerceWooCommerceSchema, default: () => ({}) }
}, { _id: false });

const AiSchema = new mongoose.Schema({
  geminiKey: { type: String, default: "" }, 
  openaiKey: { type: String, default: "" }, 
  systemPrompt: { type: String, default: "" },
  fallbackEnabled: { type: Boolean, default: true },
  negotiationSettings: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Phase 26 Voice Settings
  voiceRepliesEnabled: { type: Boolean, default: false },
  voiceReplyLanguage: { type: String, default: "en-IN" },
  voiceReplyMode: { type: String, enum: ["mirror", "always", "off"], default: "mirror" }
}, { _id: false });

const BillingSchema = new mongoose.Schema({
  plan: { type: String, default: "CX Agent (V1)" },
  tier: { type: String, enum: ['v1', 'v2'], default: 'v1' },
  trialActive: { type: Boolean, default: true },
  trialEndsAt: { type: Date },
  isPaidAccount: { type: Boolean, default: false },
  suspendedAt: { type: Date }
}, { _id: false });

const SocialInstagramSchema = new mongoose.Schema({
  pageId: { type: String, default: "" },
  accessToken: { type: String, default: "" }, 
  appSecret: { type: String, default: "" }, 
  connected: { type: Boolean, default: false },
  username: { type: String, default: "" }
}, { _id: false });

const SocialMetaAdsSchema = new mongoose.Schema({
  accountId: { type: String, default: "" },
  accessToken: { type: String, default: "" }, 
  tokenExpiry: { type: Date }
}, { _id: false });

const SocialSchema = new mongoose.Schema({
  instagram: { type: SocialInstagramSchema, default: () => ({}) },
  metaAds: { type: SocialMetaAdsSchema, default: () => ({}) }
}, { _id: false });

const ClientSchema = new mongoose.Schema({
  // --- TIER 2.5: MODULAR SUB-DOCUMENTS (Parallel Run Phase) ---
  brand: { type: BrandSchema, default: () => ({}) },
  whatsapp: { type: WhatsappSchema, default: () => ({}) },
  commerce: { type: CommerceSchema, default: () => ({}) },
  ai: { type: AiSchema, default: () => ({}) },
  billing: { type: BillingSchema, default: () => ({}) },
  social: { type: SocialSchema, default: () => ({}) },

  // --- TIER 3: ONBOARDING WIZARD CENTRALIZED VARS ---
  platformVars: {
    brandName: { type: String, trim: true },
    agentName: { type: String, trim: true },
    adminWhatsappNumber: { type: String, trim: true },
    baseCurrency: { type: String, default: '₹', trim: true },
    shippingTime: { type: String, trim: true },
    businessDescription: { type: String, trim: true },
    checkoutUrl: { type: String, trim: true },
    googleReviewUrl: { type: String, trim: true },
    supportEmail: { type: String, trim: true },
    openTime: { type: String, default: '10:00', trim: true },
    closeTime: { type: String, default: '19:00', trim: true },
    warrantyDuration: { type: String, trim: true },
    defaultTone: { type: String, default: 'friendly', trim: true },
    defaultLanguage: { type: String, default: 'Hinglish', trim: true },
  },

  faq: [{
    question: { type: String, trim: true },
    answer: { type: String, trim: true },
    order: { type: Number, default: 0 },
  }],

  // --- LEGACY FIELDS (Do Not Remove Until Phase 24 Migration Complete) ---
  clientId: { type: String, required: true, unique: true, trim: true },
  isLifetimeAdmin: { type: Boolean, default: false }, // Objective 1: God Mode Bypass
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
    enum: ['ecommerce', 'salon', 'turf', 'clinic', 'choice_salon', 'choice_salon_new', 'agency', 'travel', 'real-estate', 'healthcare', 'other'],
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
  customVariables: [{
    name: { type: String, required: true },
    type: { type: String, enum: ['string', 'number', 'date', 'phone', 'email'], default: 'string' },
    label: String,
    description: String,
    defaultValue: String,
    validationRegex: String,
    validationMessage: String
  }],
  
  // Phase 7 Added Fields
  razorpayKeyId: { type: String, default: "" },
  razorpaySecret: { type: String, default: "" },
  razorpayCustomerId: { type: String, default: "" },
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
  shopifyApiVersion: { type: String, default: "2026-01" },
  shopifyConnectionStatus: { type: String, enum: ['connected', 'error', 'disconnected'], default: 'connected' },
  lastShopifyError: { type: String, default: "" },
  generatedDiscounts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  aiUseGeneratedDiscounts: { type: Boolean, default: false }, // AI uses latest generated discount code when true
  
  // Phase 3: Operational Admin Alerts
  adminAlertWhatsapp: { type: String, default: "" }, // comma separated numbers
  adminAlertEmail: { type: String, default: "" }, // comma separated emails
  
  // Phase 25 Track 7: AI Price Negotiation Limits
  negotiationSettings: {
    enabled: { type: Boolean, default: false },
    minDiscountPercent: { type: Number, default: 5 },
    maxDiscountPercent: { type: Number, default: 15 },
    maxDiscountAmountFlat: { type: Number, default: 1000 } // Hard flat ceiling to protect margins
  },
  
  // Phase 30.5: Dynamic Intent Weighting
  intentWeights: {
    scan: { type: Number, default: 10 },
    message: { type: Number, default: 2 },
    purchase: { type: Number, default: 50 },
    linkClick: { type: Number, default: 5 },
    optOut: { type: Number, default: -100 }
  },
  
  // Phase 14 Multi-Gateway Support
  activePaymentGateway: { 
    type: String, 
    enum: ['cashfree', 'razorpay', 'stripe', 'payu', 'phonepe', 'none'], 
    default: 'none' 
  },
  cashfreeAppId: { type: String, default: "" },
  cashfreeSecretKey: { type: String, default: "" },
  stripePublishableKey: { type: String, default: "" },
  stripeSecretKey: { type: String, default: "" },
  payuMerchantKey: { type: String, default: "" },
  payuMerchantSalt: { type: String, default: "" },
  phonepeMerchantId: { type: String, default: "" },
  phonepeSaltKey: { type: String, default: "" },
  phonepeSaltIndex: { type: String, default: "" },
  
  // Phase 13 Store & Instagram Integration
  storeType: {
    type: String,
    enum: ["shopify", "woocommerce", "manual"],
    default: "shopify"
  },
  woocommerceConnected: { type: Boolean, default: false },
  woocommerceUrl:    { type: String, default: "" },
  woocommerceKey:    { type: String, default: "" },
  woocommerceSecret: { type: String, default: "" },
  woocommerceWebhookSecret: { type: String, default: "" },
  
  instagramPageId:      { type: String, default: "" },
  instagramAccessToken: { type: String, default: "" },
  instagramAppSecret:   { type: String, default: "" },
  instagramConnected:   { type: Boolean, default: false },
  
  // Phase 20: Instagram OAuth Extended Fields
  instagramUsername:     { type: String, default: "" },
  instagramTokenExpiry:  { type: Date,   default: null },
  instagramProfilePic:   { type: String, default: "" },
  instagramFollowers:    { type: Number, default: 0 },
  instagramFbPageId:     { type: String, default: "" },
  instagramPendingPages: { type: mongoose.Schema.Types.Mixed, default: null },
  instagramPendingToken: { type: String, default: "" },
  igWebhookSubscribed: { type: Boolean, default: false },

  // Phase 20: AI Onboarding Wizard
  wizardCompleted:       { type: Boolean, default: false },
  wizardCompletedAt:     { type: Date,    default: null },
  
  // messageTemplates stored as flexible Mixed array to support both 
  // legacy sub-documents and new flow-based template references
  messageTemplates: { type: mongoose.Schema.Types.Mixed, default: [] },
  
  automationFlows: [{
    id:       { type: String },
    type:     { type: String }, // ✅ Phase R4: Added — e.g. 'abandoned_cart', 'cod_to_prepaid', 'review_collection'
    name:     { type: String },
    isActive: { type: Boolean, default: false },
    config:   { type: mongoose.Schema.Types.Mixed, default: {} }
  }],
  
  // Phase 9 Visual Node Builder Fields
  flowNodes: { type: [mongoose.Schema.Types.Mixed], default: [] },
  flowEdges: { type: [mongoose.Schema.Types.Mixed], default: [] },
  
  // Phase 15 Visual Builder Multi-Flow Architecture
  flowFolders: { type: [mongoose.Schema.Types.Mixed], default: [] }, // { id: String, name: String, createdAt: Date }
  visualFlows: { type: [mongoose.Schema.Types.Mixed], default: [] }, // { id: String, name: String, folderId: String, platform: String, isActive: Boolean, nodes: [], edges: [], createdAt: Date, updatedAt: Date }
  flowMigrationStatus: { 
    type: String, 
    enum: ['pending', 'completed', 'verified', 'failed'], 
    default: 'pending' 
  },

  
  // Phase 9 AI & Settings
  systemPrompt: { type: String, default: '' },
  pendingTemplates: { type: mongoose.Schema.Types.Mixed, default: [] },
  syncedMetaTemplates: { type: mongoose.Schema.Types.Mixed, default: [] },
  syncedMetaFlows: { type: mongoose.Schema.Types.Mixed, default: [] },
  
  // Phase 28: Auto-Healing & Status Tracking
  healthStatus: { 
    type: String, 
    enum: ['operational', 'degraded', 'offline', 'maintenance'], 
    default: 'operational' 
  },
  maintenancePulse: {
    lastError: String,
    lastErrorAt: Date,
    errorCount24h: { type: Number, default: 0 },
    autoHealedCount: { type: Number, default: 0 }
  },

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
      aiLanguages: ['en', 'hi', 'gu', 'hinglish', 'guajarlish'], // Default enabled languages
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
  pendingKnowledge: [{
    type: { type: String, enum: ['faq', 'fact', 'product'], default: 'fact' },
    content: mongoose.Schema.Types.Mixed,
    sourceLead: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead' },
    extractedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
  }],
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

  // Phase 21: Handoff & Automation Control
  handoffMode: {
    type: String,
    enum: ['AUTO', 'MANUAL', 'HYBRID'],
    default: 'AUTO' // AUTO: Bot handles all, MANUAL: Human handles all, HYBRID: Bot handles flows, human handles context
  },
  handoffTimeout: { type: Number, default: 30 }, // Minutes before bot takes back control in HYBRID mode
  manualSwitchAlert: { type: Boolean, default: true },

  // Phase 22: Rules Engine
  automationRules: { type: [mongoose.Schema.Types.Mixed], default: [] }, // { id, name, trigger, conditions, actions, priority, isActive }
  routingRules: { type: [mongoose.Schema.Types.Mixed], default: [] }, // { id, priority, conditions, fallbackAgentId, agentIds, routeType }

  // Phase 24: Meta Ads Manager
  metaAdsConnected:    { type: Boolean, default: false },
  metaAdAccountId:     { type: String, default: '' },
  metaAdsToken:        { type: String, default: '' },
  metaAdsTokenExpiry:  { type: Date },
  metaAdsAccountName:  { type: String, default: '' },

  // Phase 24: WhatsApp Catalog
  waCatalogId:         { type: String, default: '' },
  catalogSyncedAt:     { type: Date },
  catalogProductCount: { type: Number, default: 0 },
  catalogEnabled:      { type: Boolean, default: false },

  // Phase 24: Smart Cart Recovery
  smartCartRecovery:   { type: Boolean, default: false },

  // Phase 24: Reseller Fields
  resellerUserId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resellerPlan:        { type: String, default: '' },
  billedToReseller:    { type: Boolean, default: false },

  // Phase 25: Email Support Channel
  resendApiKey:        { type: String, default: '' },
  emailIdentity:       { type: String, default: '' },

  createdAt: { type: Date, default: Date.now },

  // Phase 27: Multi-WABA & Enterprise
  wabaAccounts: [{
    phoneNumberId: String,
    wabaId: String,
    accessToken: String,
    phoneNumber: String,
    displayName: String,
    qualityRating: String, // GREEN, YELLOW, RED
    verifiedName: String
  }],

  // Phase 27: Loyalty Ecosystem Config
  loyaltyConfig: {
    enabled: { type: Boolean, default: false },
    pointsPerUnit: { type: Number, default: 10 }, // e.g. 10 points per ₹100
    currencyUnit: { type: Number, default: 100 },
    tierThresholds: {
      bronze: { type: Number, default: 0 },
      silver: { type: Number, default: 5000 },
      gold: { type: Number, default: 15000 },
      platinum: { type: Number, default: 50000 }
    },
    redeemUrl: { type: String, default: "" }, // Phase 27: Loyalty UI redirect URL
    autoApplyDiscount: { type: Boolean, default: false }
  },

  // Phase 28: Bidirectional Translation
  translationConfig: {
    enabled: { type: Boolean, default: false },
    agentLanguage: { type: String, default: "en" }
  },
  
  // Phase 28: Native Order Taking (Track 5)
  waOrderTaking: {
    enabled: { type: Boolean, default: false },
    acceptCOD: { type: Boolean, default: true },
    acceptOnline: { type: Boolean, default: false },
    requireAddress: { type: Boolean, default: true },
    confirmationTemplate: { type: String, default: "" }
  },
  
  // Phase 2: SKU-to-Template Trigger Engine
  skuAutomations: [{
    sku: { type: String, required: true },
    templateName: { type: String, required: true },
    language: { type: String, default: 'en' },
    triggerEvent: { type: String, enum: ['paid', 'shipped', 'abandoned', 'stock_alert'], default: 'paid' },
    isActive: { type: Boolean, default: true },
    description: String,
    imageUrl: String, // Optional override image
    inventoryThreshold: { type: Number, default: 0 },
    supplierPhone: { type: String, default: "" }
  }],

  // Phase 29: Dashboard Personalization
  dashboardConfig: {
    layout: { type: [mongoose.Schema.Types.Mixed], default: [] }, // [{ id, x, y, w, h, i }]
    hiddenWidgets: { type: [String], default: [] }
  },

  // Phase 29: AI Persona & Customization
  ai: {
    persona: {
      name:             { type: String, default: "TopEdge AI Assistant" },
      avatar:           { type: String, default: "" },
      tone:             { type: String, default: "Professional & Helpful" },
      description:      { type: String, default: "You are an automated assistant dedicated to providing fast and accurate business support." },
      // ✅ Phase R4: Missing canonical persona fields added (personaEngine.js reads all of these)
      role:             { type: String, default: "customer support specialist" },
      language:         { type: String, default: "English" },
      emojiLevel:       { type: String, enum: ["none", "minimal", "moderate", "high"], default: "moderate" },
      formality:        { type: String, enum: ["formal", "semi-formal", "casual"], default: "semi-formal" },
      autoTranslate:    { type: Boolean, default: false },
      knowledgeBase:    { type: String, default: "" }, // FAQs, policies, product info injected into prompts
      signaturePhrases: { type: [String], default: [] },  // Rotating phrases (e.g., "Happy to help!")
      avoidTopics:      { type: [String], default: [] }   // Topics the bot must never discuss
    },
    trainingData: [{
      userMessage: { type: String },
      originalResponse: { type: String },
      agentCorrection: { type: String },
      context: { type: String },
      createdAt: { type: Date, default: Date.now }
    }],
    supplierAlerts: {
      enabled: { type: Boolean, default: true },
      autoSend: { type: Boolean, default: false },
      notificationSent: { type: Boolean, default: false }
    }
  },
  
  // Phase 29: B2B Supplier Channel
  isSupplier: { type: Boolean, default: false },
  b2bCatalog: [{
    productId: String,
    title: String,
    wholesalePrice: Number,
    minOrderQuantity: { type: Number, default: 1 },
    sku: String
  }],
  b2bSettings: {
    allowDirectWholesale: { type: Boolean, default: false },
    autoApproveSuppliers: { type: Boolean, default: false },
    commissionRate: { type: Number, default: 0 }
  },

  createdAt: { type: Date, default: Date.now }
});

function encryptSubDocs(doc) {
  // Use a strictly safe encryption helper
  const enc = (val) => {
    if (typeof val !== 'string') return val;
    try {
      return encrypt(val);
    } catch (e) {
      return val;
    }
  };
  
  if (doc.whatsapp?.accessToken) doc.whatsapp.accessToken = enc(doc.whatsapp.accessToken);
  if (doc.commerce?.shopify?.accessToken) doc.commerce.shopify.accessToken = enc(doc.commerce.shopify.accessToken);
  if (doc.commerce?.shopify?.refreshToken) doc.commerce.shopify.refreshToken = enc(doc.commerce.shopify.refreshToken);
  if (doc.commerce?.shopify?.clientSecret) doc.commerce.shopify.clientSecret = enc(doc.commerce.shopify.clientSecret);
  if (doc.commerce?.shopify?.webhookSecret) doc.commerce.shopify.webhookSecret = enc(doc.commerce.shopify.webhookSecret);
  if (doc.commerce?.woocommerce?.key) doc.commerce.woocommerce.key = enc(doc.commerce.woocommerce.key);
  if (doc.commerce?.woocommerce?.secret) doc.commerce.woocommerce.secret = enc(doc.commerce.woocommerce.secret);
  if (doc.commerce?.woocommerce?.webhookSecret) doc.commerce.woocommerce.webhookSecret = enc(doc.commerce.woocommerce.webhookSecret);
  if (doc.ai?.geminiKey) doc.ai.geminiKey = enc(doc.ai.geminiKey);
  if (doc.ai?.openaiKey) doc.ai.openaiKey = enc(doc.ai.openaiKey);
  if (doc.social?.instagram?.accessToken) doc.social.instagram.accessToken = enc(doc.social.instagram.accessToken);
  if (doc.social?.instagram?.appSecret) doc.social.instagram.appSecret = enc(doc.social.instagram.appSecret);
  if (doc.social?.metaAds?.accessToken) doc.social.metaAds.accessToken = enc(doc.social.metaAds.accessToken);
  
  // Legacy Encryptions
  if (doc.whatsappToken) doc.whatsappToken = enc(doc.whatsappToken);
  if (doc.shopifyAccessToken) doc.shopifyAccessToken = enc(doc.shopifyAccessToken);
  if (doc.shopifyRefreshToken) doc.shopifyRefreshToken = enc(doc.shopifyRefreshToken);
  if (doc.shopifyWebhookSecret) doc.shopifyWebhookSecret = enc(doc.shopifyWebhookSecret);
  if (doc.shopifyClientSecret) doc.shopifyClientSecret = enc(doc.shopifyClientSecret);
  if (doc.woocommerceSecret) doc.woocommerceSecret = enc(doc.woocommerceSecret);
  if (doc.geminiApiKey) doc.geminiApiKey = enc(doc.geminiApiKey);
  if (doc.openaiApiKey) doc.openaiApiKey = enc(doc.openaiApiKey);
  if (doc.instagramAccessToken) doc.instagramAccessToken = enc(doc.instagramAccessToken);
  if (doc.instagramAppSecret) doc.instagramAppSecret = enc(doc.instagramAppSecret);
  if (doc.razorpaySecret) doc.razorpaySecret = enc(doc.razorpaySecret);
  if (doc.cashfreeSecretKey) doc.cashfreeSecretKey = enc(doc.cashfreeSecretKey);
  if (doc.stripeSecretKey) doc.stripeSecretKey = enc(doc.stripeSecretKey);
  if (doc.payuMerchantSalt) doc.payuMerchantSalt = enc(doc.payuMerchantSalt);
  if (doc.phonepeSaltKey) doc.phonepeSaltKey = enc(doc.phonepeSaltKey);
  if (doc.emailAppPassword) doc.emailAppPassword = enc(doc.emailAppPassword);
}

function encryptUpdateQuery(update) {
  if (!update) return;
  const setOps = update.$set || update;
  const enc = (val) => {
    if (typeof val !== 'string') return val;
    try {
      return encrypt(val);
    } catch (e) {
      return val;
    }
  };
  
  const encPaths = [
    'whatsapp.accessToken', 'commerce.shopify.accessToken', 'commerce.shopify.refreshToken', 'commerce.shopify.clientSecret', 'commerce.shopify.webhookSecret',
    'commerce.woocommerce.key', 'commerce.woocommerce.secret', 'commerce.woocommerce.webhookSecret',
    'ai.geminiKey', 'ai.openaiKey', 'social.instagram.accessToken', 'social.instagram.appSecret', 'social.metaAds.accessToken',
    'whatsappToken', 'shopifyAccessToken', 'shopifyRefreshToken', 'shopifyWebhookSecret', 'shopifyClientSecret',
    'woocommerceSecret', 'geminiApiKey', 'openaiApiKey', 'instagramAccessToken', 
    'instagramAppSecret', 'razorpaySecret', 'cashfreeSecretKey', 'stripeSecretKey', 
    'payuMerchantSalt', 'phonepeSaltKey', 'emailAppPassword'
  ];

  for (const path of encPaths) {
    if (setOps[path]) setOps[path] = enc(setOps[path]);
  }
}

ClientSchema.pre('save', function(next) {
  encryptSubDocs(this);
  next();
});

ClientSchema.pre('findOneAndUpdate', function(next) {
  encryptUpdateQuery(this.getUpdate());
  next();
});

ClientSchema.pre('update', function(next) {
  encryptUpdateQuery(this.getUpdate());
  next();
});

ClientSchema.pre('updateOne', function(next) {
  encryptUpdateQuery(this.getUpdate());
  next();
});

module.exports = mongoose.model('Client', ClientSchema);
