const mongoose = require('mongoose');
const { encrypt } = require('../utils/core/encryption');

// --- TIER 2.5 SUB-DOCUMENT SCHEMAS ---

const BrandSchema = new mongoose.Schema({
  businessName: { type: String, default: "" },
  businessLogo: { type: String, default: "" },
  currency: { type: String, default: "₹" },
  niche: { type: String, default: "other" },
  businessType: { type: String, default: "ecommerce" },
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

const CommerceSchema = new mongoose.Schema({
  storeType: { type: String, enum: ["shopify", "manual"], default: "shopify" },
  shopify: { type: CommerceShopifySchema, default: () => ({}) }
}, { _id: false });

// ───────────────────────────────────────────────────────────────────────────
// AI persona — owned by AiSchema below. Lives at `client.ai.persona.*`
// (personaEngine.js + flowGenerator.js + Wizard all read these exact paths).
// ───────────────────────────────────────────────────────────────────────────
const AiPersonaSchema = new mongoose.Schema({
  name:             { type: String, default: "TopEdge AI Assistant" },
  avatar:           { type: String, default: "" },
  tone:             { type: String, default: "Professional & Helpful" },
  description:      { type: String, default: "You are an automated assistant dedicated to providing fast and accurate business support." },
  role:             { type: String, default: "customer support specialist" },
  language:         { type: String, default: "English" },
  emojiLevel:       { type: String, enum: ["none", "minimal", "moderate", "high"], default: "moderate" },
  formality:        { type: String, enum: ["formal", "semi-formal", "casual"], default: "semi-formal" },
  autoTranslate:    { type: Boolean, default: false },
  knowledgeBase:    { type: String, default: "" },
  signaturePhrases: { type: [String], default: [] },
  avoidTopics:      { type: [String], default: [] }
}, { _id: false });

const AiSchema = new mongoose.Schema({
  geminiKey: { type: String, default: "" },
  openaiKey: { type: String, default: "" },
  systemPrompt: { type: String, default: "" },
  enterprisePersona: { type: String, default: "" },
  fallbackEnabled: { type: Boolean, default: true },
  negotiationSettings: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Phase 26 Voice Settings
  voiceRepliesEnabled: { type: Boolean, default: false },
  voiceReplyLanguage: { type: String, default: "en-IN" },
  voiceReplyMode: { type: String, enum: ["mirror", "always", "off"], default: "mirror" },

  // Phase 29 — Persona / training / supplier alerts.
  // Previously lived in a SECOND `ai:` field at the bottom of ClientSchema,
  // which silently overrode this whole sub-document. Merged here so the
  // schema has exactly ONE source of truth for `client.ai.*`.
  persona: { type: AiPersonaSchema, default: () => ({}) },
  trainingData: [{
    userMessage:       { type: String },
    originalResponse:  { type: String },
    agentCorrection:   { type: String },
    context:           { type: String },
    createdAt:         { type: Date, default: Date.now }
  }],
  supplierAlerts: {
    enabled:          { type: Boolean, default: true },
    autoSend:         { type: Boolean, default: false },
    notificationSent: { type: Boolean, default: false }
  }
}, { _id: false });

// ───────────────────────────────────────────────────────────────────────────
// WIZARD FEATURE TOGGLES — single object the Onboarding Wizard owns.
// flowGenerator.js consults these to conditionally insert/skip whole node
// branches. The Settings → Features panel mutates these fields and triggers
// a background flow regeneration.
//
// IMPORTANT: every toggle that changes the *generated WhatsApp flow graph* MUST have
// a matching builder block in flowGenerator.js. Pure server/webhook toggles
// (e.g. enableAutoShopifyShippedWhatsApp) intentionally have no flow branch.
// ───────────────────────────────────────────────────────────────────────────
const WizardFeaturesSchema = new mongoose.Schema({
  // Core commerce
  enableCatalog:           { type: Boolean, default: true  }, // Show product catalog branch from main menu
  enableOrderTracking:     { type: Boolean, default: true  }, // Shopify order status branch
  enableReturnsRefunds:    { type: Boolean, default: true  }, // Returns + refund branch
  enableCancelOrder:       { type: Boolean, default: true  }, // Cancellation flow under order ops
  cancelRequireReason:     { type: Boolean, default: true  },
  cancelAllowModify:       { type: Boolean, default: true  },
  enableCodToPrepaid:      { type: Boolean, default: false }, // Auto-nudge after COD orders to convert to prepaid
  codDiscountAmount:       { type: Number,  default: 50    }, // ₹ off to incentivize switch
  enableAbandonedCart:     { type: Boolean, default: true  }, // 3-step cart recovery drip
  enableCatalogCheckoutRecovery: { type: Boolean, default: true }, // Follow up after catalog open with checkout reminder
  catalogCheckoutDelayMin: { type: Number,  default: 20    }, // Minutes before first checkout reminder
  /** WS-3 defaults (June 2026): keep aligned with
   *  cron/abandonedCartScheduler.CART_NUDGE_DEFAULTS so existing tenants
   *  who haven't clicked Enable still get msg #1 within 25–30 min. */
  cartNudgeMinutes1:       { type: Number,  default: 25    },
  cartNudgeHours2:         { type: Number,  default: 4     },
  cartNudgeHours3:         { type: Number,  default: 36    },
  cartNudgeTemplate1:      { type: String,  default: ""    },
  cartNudgeTemplate2:      { type: String,  default: ""    },
  cartNudgeTemplate3:      { type: String,  default: ""    },

  // Growth
  enableReferral:          { type: Boolean, default: false },
  referralPointsBonus:     { type: Number,  default: 500   },
  enableReviewCollection:  { type: Boolean, default: false }, // Post-delivery Google review request
  reviewDelayDays:         { type: Number,  default: 4     },

  // Service & post-purchase
  enableWarranty:          { type: Boolean, default: false },
  /** When warranty was last turned on — orders before this are not auto-assigned */
  warrantyEnabledAt:       { type: Date, default: null },
  warrantyGeneratePdf:     { type: Boolean, default: true  },
  warrantyDuration:        { type: String,  default: "1 Year" },
  warrantySupportPhone:    { type: String,  default: "" },
  warrantySupportEmail:    { type: String,  default: "" },
  warrantyClaimUrl:        { type: String,  default: "" },
  enableInstallSupport:    { type: Boolean, default: false },
  helpIncludeInstallGuide: { type: Boolean, default: true  },
  installProductType:      { type: String,  default: "Electronics" },
  installSupportPrompt:    { type: String,  default: "Need install help? Share your exact product name and I will guide you." },
  enableFAQ:               { type: Boolean, default: true  },
  enableSupportEscalation: { type: Boolean, default: true  },
  humanEscalationTimeoutMin: { type: Number, default: 30   }, // Auto-return to bot after N minutes
  enableBusinessHoursGate: { type: Boolean, default: true  },
  enable247:               { type: Boolean, default: false }, // If true, skip the after-hours block

  // Channels & growth
  enableInstagramTrigger:  { type: Boolean, default: false },
  enableMetaAdsTrigger:    { type: Boolean, default: false },
  enableB2BWholesale:      { type: Boolean, default: false },

  // AI behavior
  enableAIFallback:        { type: Boolean, default: true  }, // Dead-end → AI smart reply
  enableMultiLanguage:     { type: Boolean, default: false }, // Auto-translate inbound + outbound

  // Notifications
  enableAdminAlerts:       { type: Boolean, default: true  }, // WhatsApp + email blast on critical events
  enableOrderConfirmTpl:   { type: Boolean, default: true  },
  codConfirmationMinutes:  { type: Number,  default: 10   },
  /**
   * When true (default), Shopify fulfillment / order webhooks that mark an order shipped
   * may send the mapped "shipped" WhatsApp template (and session fallback text).
   * Does not alter generated chat flows — server-side automation only.
   */
  enableAutoShopifyShippedWhatsApp: { type: Boolean, default: true }
}, { _id: false });

/** Per-tenant cart recovery timing + smart send (Phase 3 SSOT). */
const CartRecoveryConfigSchema = new mongoose.Schema({
  promotionDelayMinutes: { type: Number, default: 10 },
  step1DelayMinutes: { type: Number, default: 25 },
  step2DelayMinutes: { type: Number, default: 240 },
  step3DelayMinutes: { type: Number, default: 2160 },
  smartSendEnabled: { type: Boolean, default: true },
  smartSendStartHour: { type: Number, default: 8 },
  smartSendEndHour: { type: Number, default: 22 },
  timezone: { type: String, default: 'Asia/Kolkata' },
  attributionWindowHours: { type: Number, default: 24 },
  discountEnabled: { type: Boolean, default: false },
  discountStep2Pct: { type: Number, default: 0 },
  discountStep3Pct: { type: Number, default: 0 },
}, { _id: false });

/** RTO Protection Suite — COD confirmation + NDR rescue (WhatsApp). */
const RtoProtectionSchema = new mongoose.Schema({
  requireCodConfirmation: { type: Boolean, default: false },
  enableNdrRescue: { type: Boolean, default: false },
  /** Auto-push customer NDR replies to Shiprocket when API credentials are configured. */
  enableNdrAutoPush: { type: Boolean, default: true },
  codConfirmationHours: { type: Number, default: 24 },
  estimatedRtoCostPerOrder: { type: Number, default: 800 },
  /** Meta utility template (approved) — required outside 24h session; default name merchants can create. */
  ndrTemplateName: { type: String, default: 'rto_ndr_rescue' },
  ndrTemplateLanguage: { type: String, default: 'en' },
}, { _id: false });

/** Courier tracking eligibility — Shopify sync vs direct partner webhook. */
const LogisticsHealthSchema = new mongoose.Schema({
  shopifyPathActive: { type: Boolean, default: true },
  observedShopifyStatuses: { type: [String], default: [] },
  directWebhookActive: { type: Boolean, default: false },
  directWebhookLastSeenAt: { type: Date, default: null },
  lastHealthCheckAt: { type: Date, default: null },
}, { _id: false });

const LogisticsIntegrationSchema = new mongoose.Schema({
  planDeclared: { type: Boolean, default: false },
  planDeclaredAt: { type: Date, default: null },
  webhookSecret: { type: String, default: '' },
  connectedAt: { type: Date, default: null },
  /** Shiprocket API user (Settings → API) — for NDR reattempt push-back. */
  shiprocketApiEmail: { type: String, default: '' },
  shiprocketApiPasswordEnc: { type: String, default: '' },
  shiprocketTokenEnc: { type: String, default: '' },
  shiprocketTokenExpiresAt: { type: Date, default: null },
}, { _id: false });

// ───────────────────────────────────────────────────────────────────────────
// Plain-text business policies the AI / generator can quote verbatim.
// ───────────────────────────────────────────────────────────────────────────
const PoliciesSchema = new mongoose.Schema({
  returnPolicy:   { type: String, default: "" },
  refundPolicy:   { type: String, default: "" },
  shippingPolicy: { type: String, default: "" },
  warrantyPolicy: { type: String, default: "" },
  privacyUrl:     { type: String, default: "" },
  termsUrl:       { type: String, default: "" }
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
  ai: { type: AiSchema, default: () => ({}) }, // Persona, training, voice, keys all live here.
  billing: { type: BillingSchema, default: () => ({}) },
  social: { type: SocialSchema, default: () => ({}) },

  // --- Growth + compliance (website embed, cart automations) ---
  growthCompliance: {
    cartRecoveryRequiresOptIn: { type: Boolean, default: false }, // strict: cart nudges only opted_in
    defaultOptInPolicy: { type: String, enum: ['single', 'double'], default: 'single' },
    applyPolicyToNewSignups: { type: Boolean, default: true },
    stopKeywords: {
      type: [String],
      default: () => ['STOP', 'UNSUBSCRIBE', 'OPT OUT', 'REMOVE', 'CANCEL'],
    },
  },
  /** Shopify stack + third-party checkout (Gokwik, Razorpay Magic, Shiprocket) — merchant + auto-detect */
  audienceContext: {
    storePlatform: {
      type: String,
      enum: ['shopify', 'none'],
      default: 'none',
    },
    thirdPartyCheckout: {
      type: String,
      enum: [
        'shopify_native',
        'gokwik',
        'razorpay_magic',
        'shiprocket',
        'other_third_party',
        'unknown',
        'not_sure',
      ],
      default: 'unknown',
    },
    checkoutSignal: {
      type: String,
      enum: ['merchant_declared', 'shopify_app_list', 'webhook_history', null],
      default: null,
    },
    integrations: {
      gokwik: {
        apiKeySet: { type: Boolean, default: false },
        webhookSecret: { type: String, default: '' },
        consentStrategy: { type: String, enum: ['implicit', 'explicit'], default: 'explicit' },
        lastWebhookAt: { type: Date, default: null },
        lastTestAt: { type: Date, default: null },
      },
      razorpay_magic: {
        webhookSecret: { type: String, default: '' },
        consentStrategy: { type: String, enum: ['implicit', 'explicit'], default: 'explicit' },
        lastWebhookAt: { type: Date, default: null },
        lastTestAt: { type: Date, default: null },
      },
      shiprocket_checkout: {
        webhookSecret: { type: String, default: '' },
        consentStrategy: { type: String, enum: ['implicit', 'explicit'], default: 'explicit' },
        lastWebhookAt: { type: Date, default: null },
        lastTestAt: { type: Date, default: null },
      },
      generic: {
        webhookSecret: { type: String, default: '' },
        consentStrategy: { type: String, enum: ['implicit', 'explicit'], default: 'explicit' },
        lastWebhookAt: { type: Date, default: null },
      },
    },
    manualOverrides: {
      storePlatform: { type: String, default: null },
      thirdPartyCheckout: { type: String, default: null },
    },
    updatedAt: { type: Date, default: null },
  },
  complianceConfig: {
    channels: {
      whatsapp: {
        enabled: { type: Boolean, default: true },
      },
      instagram: {
        enabled: { type: Boolean, default: false },
      },
      email: {
        enabled: { type: Boolean, default: true },
      },
    },
    strictMode: { type: Boolean, default: true },
    marketingWindowHours: { type: Number, default: 720 },
    /** Per-channel send budgets — configured vs effective (Phase 3 A11). */
    rateLimits: {
      whatsapp: {
        configured: {
          sustainedPerSec: { type: Number, default: 10 },
          burst: { type: Number, default: 30 },
        },
        effective: {
          sustainedPerSec: { type: Number, default: 10 },
          burst: { type: Number, default: 30 },
        },
        throttledUntil: { type: Date, default: null },
        lastThrottleReason: { type: String, default: null },
        lastThrottledAt: { type: Date, default: null },
      },
      email: {
        configured: {
          sustainedPerSec: { type: Number, default: 50 },
          burst: { type: Number, default: 200 },
        },
        effective: {
          sustainedPerSec: { type: Number, default: 50 },
          burst: { type: Number, default: 200 },
        },
        throttledUntil: { type: Date, default: null },
        lastThrottleReason: { type: String, default: null },
        lastThrottledAt: { type: Date, default: null },
      },
      instagram: {
        configured: {
          sustainedPerSec: { type: Number, default: 5 },
          burst: { type: Number, default: 15 },
        },
        effective: {
          sustainedPerSec: { type: Number, default: 5 },
          burst: { type: Number, default: 15 },
        },
        throttledUntil: { type: Date, default: null },
        lastThrottleReason: { type: String, default: null },
        lastThrottledAt: { type: Date, default: null },
      },
    },
    concurrency: {
      whatsapp: { maxParallel: { type: Number, default: 10 } },
      email: { maxParallel: { type: Number, default: 20 } },
      instagram: { maxParallel: { type: Number, default: 5 } },
    },
  },
  flags: {
    /** @deprecated Slice 7 — envelope is always on; kept for backward-compatible reads only. */
    useSendEnvelope: { type: Boolean, default: true },
  },
  /** Public key embedded in storefront widget script — NEVER use clientId alone in browser */
  growthEmbedPublicKey: { type: String, trim: true, default: '', index: true, sparse: true },
  growthEmbedEnabled: { type: Boolean, default: true },
  growthWidgetConfig: {
    activeWidgets: { type: [String], default: ['floating_button'] },
    floatingButton: {
      position: { type: String, default: 'right' },
      color: { type: String, default: '#25D366' },
      label: { type: String, default: 'WhatsApp' },
      delaySeconds: { type: Number, default: 3 },
    },
    exitPopup: {
      headline: { type: String, default: 'Wait! Get updates on WhatsApp' },
      offerText: { type: String, default: 'Subscribe for offers and order updates.' },
      cooldownDays: { type: Number, default: 3 },
    },
    spinWheel: {
      prizes: {
        // Keep prize entries permissive to avoid CastErrors during account creation
        // when legacy payloads/stringified defaults are present in older environments.
        type: [mongoose.Schema.Types.Mixed],
        default: () => [{ label: 'Flat 10% Off', code: 'WELCOME10', probability: 100, type: 'discount' }],
      },
      primaryColor: { type: String, default: '#6D28D9' },
      secondaryColor: { type: String, default: '#F59E0B' },
      triggerType: { type: String, default: 'time' }, // time | exit | button
      triggerDelay: { type: Number, default: 8 },
    },
    stickyBar: {
      text: { type: String, default: 'Get updates and offers on WhatsApp' },
      position: { type: String, default: 'bottom' },
    },
    inlineForm: {
      heading: { type: String, default: 'Join our WhatsApp community' },
      buttonText: { type: String, default: 'Subscribe' },
      successMessage: { type: String, default: 'You are subscribed!' },
    },
    thankYouPage: {
      enabled: { type: Boolean, default: false },
      headline: { type: String, default: 'Thank you for your order, {customer_name}!' },
      body: {
        type: String,
        default: 'Get your shipping updates and exclusive offers on WhatsApp.',
      },
      buttonText: { type: String, default: 'Join on WhatsApp' },
      delaySeconds: { type: Number, default: 0 },
      timingMode: { type: String, enum: ['immediate', 'delay'], default: 'immediate' },
    },
    consentText: { type: String, default: 'I agree to receive WhatsApp messages from this brand.' },
    doubleOptInEnabled: { type: Boolean, default: false },
    welcomeMessage: { type: String, default: 'Welcome to our WhatsApp updates!' },
  },

  /** Website chat widget (Settings → Chat Widget, public/widget.js) */
  websiteChatWidgetConfig: {
    enabled: { type: Boolean, default: true },
    mode: { type: String, default: 'both' }, // whatsapp | form | both | guided
    experience: { type: String, default: 'classic' }, // classic | guided
    flowId: { type: String, default: '' },
    theme: { type: String, default: '#7C3AED' },
    themeSecondary: { type: String, default: '#5B21B6' },
    position: { type: String, default: 'bottom-right' },
    delaySeconds: { type: Number, default: 3 },
    greeting: { type: String, default: 'Hi! How can we help you today? 👋' },
    launcherIcon: { type: String, default: 'chat' }, // chat | whatsapp | sparkle | custom
    customIconUrl: { type: String, default: '' },
    headerTitle: { type: String, default: '' },
    headerSubtitle: { type: String, default: '' },
    showPoweredBy: { type: Boolean, default: true },
    poweredByText: { type: String, default: 'Powered by AI' },
    poweredByUrl: { type: String, default: 'https://topedgeai.com' },
    logoUrl: { type: String, default: '' },
    launcherStyle: { type: String, default: 'pill' }, // circle | pill
    launcherLabel: { type: String, default: 'Chat with us' },
    autoOpen: { type: Boolean, default: false },
    bubblePulse: { type: Boolean, default: true },
  },

  // --- WIZARD-OWNED CONFIG (Onboarding → Settings → Generator) ---
  wizardFeatures: { type: WizardFeaturesSchema, default: () => ({}) },
  cartRecoveryConfig: { type: CartRecoveryConfigSchema, default: () => ({}) },
  rtoProtection: { type: RtoProtectionSchema, default: () => ({}) },
  logisticsPartner: {
    type: String,
    enum: ['shiprocket', 'nimbuspost', 'ithink', 'shyplite', 'other', 'unknown'],
    default: 'unknown',
  },
  logisticsMode: {
    type: String,
    enum: ['shopify_only', 'direct', 'hybrid'],
    default: 'shopify_only',
  },
  logisticsIntegration: { type: LogisticsIntegrationSchema, default: () => ({}) },
  logisticsHealth: { type: LogisticsHealthSchema, default: () => ({}) },
  policies:       { type: PoliciesSchema,       default: () => ({}) },

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
    lastSyncedAt: { type: Date, default: null },
    storeUrl: { type: String, trim: true, default: '' },
    shopifyProductCount: { type: Number, default: 0 },
    shopifyDomain: { type: String, trim: true, default: '' },
    shopifyPhoneField: { type: Boolean, default: false },
    /** Meta GET webhook verification succeeded for this workspace URL (WhatsApp → Configuration). */
    whatsappWebhookMetaVerifiedAt: { type: Date, default: null },
    /** Last inbound WhatsApp Cloud API POST (messages or statuses) routed to this client. */
    whatsappLastInboundWebhookAt: { type: Date, default: null },
    /** User clicked “I connected webhook in Meta” in dashboard (hint only). */
    whatsappWebhookSetupAckAt: { type: Date, default: null },
  },

  faq: [{
    question: { type: String, trim: true },
    answer: { type: String, trim: true },
    order: { type: Number, default: 0 },
  }],

  // --- LEGACY FIELDS (Do Not Remove Until Phase 24 Migration Complete) ---
  clientId: { type: String, required: true, unique: true, trim: true },
  /** Legacy/slugs kept for backward-compatible inbound webhook URLs. */
  clientAliases: { type: [String], default: [] },
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
    default: 'ecommerce'
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

  // ── Embedded Signup v4 fields ─────────────────────────────────────────────
  whatsappConnectionType: { type: String, enum: ['manual', 'embedded_signup'], default: 'manual' },
  whatsappCoexistence: { type: Boolean, default: false }, // WA Business App + Cloud API on same number
  whatsappDisplayPhoneNumber: { type: String, default: '' },
  whatsappVerifiedName: { type: String, default: '' },
  whatsappQualityRating: { type: String, enum: ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'], default: 'UNKNOWN' },
  whatsappQualityHistory: { type: [{ rating: String, changedAt: Date }], default: [] },
  whatsappWebhookSubscribed: { type: Boolean, default: false },
  whatsappConnectedAt: { type: Date, default: null },
  whatsappConnectionMethod: { type: String, default: '' }, // 'embedded_signup_v4' | 'manual'
  whatsappAccountStatus: { type: String, default: 'active' }, // active | restricted | under_review
  whatsappRestricted: { type: Boolean, default: false },
  whatsappMessagingLimit: { type: String, default: '' }, // tier from Meta
  whatsappOnboardingCompleted: { type: Boolean, default: false },
  whatsappRegistrationPin: { type: String, default: '' }, // encrypted via pre-save
  // ─────────────────────────────────────────────────────────────────────────

  googleCalendarId: { type: String }, // Store the client's specific Google Calendar ID
  geminiApiKey: { type: String }, // Store the client's specific Gemini API Key
  openaiApiKey: { type: String }, // Legacy field (aliased to geminiApiKey in middleware)
  emailUser: { type: String },  // Gmail address for email broadcasts
  emailAppPassword: { type: String },  // Gmail App Password (not the login password)
  emailMethod: { type: String, enum: ['smtp', 'gmail_oauth'], default: 'smtp' },
  googleConnected: { type: Boolean, default: false },
  gmailAddress: { type: String, default: '' },
  gmailAccessToken: { type: String, default: '' },
  gmailRefreshToken: { type: String, default: '' },
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
  /** Phase 8: multi-store portfolio (MVP). Legacy shopDomain mirrors primary entry. */
  shopifyStores: [{
    shopDomain: { type: String, required: true },
    accessToken: { type: String, default: '' },
    scopes: { type: String, default: '' },
    connectedAt: { type: Date, default: Date.now },
    isPrimary: { type: Boolean, default: false },
    label: { type: String, default: 'Store' },
    status: { type: String, enum: ['connected', 'disconnected', 'token_expired'], default: 'connected' },
  }],
  shopifyAccessToken: { type: String, default: "" },
  shopifyRefreshToken: { type: String, default: "" },
  shopifyTokenExpiresAt: { type: Date },
  shopifyScopes: { type: String, default: "" },
  shopifyWebhookSecret: { type: String, default: "" },
  shopifyClientId: { type: String, default: "" },
  shopifyClientSecret: { type: String, default: "" },
  shopifyApiVersion: { type: String, default: "2026-04" },
  shopifyInstallLink: { type: String, default: null }, // Added for Custom App Distribution
  shopifyConnectionStatus: { type: String, enum: ['connected', 'error', 'disconnected', 'pending_link'], default: 'connected' },
  /** Amazon SP-API (Login with Amazon + seller credentials) */
  amazonConfig: {
    sellerId: { type: String, default: '' },
    marketplaceId: { type: String, default: 'A21TJ7DG3Y56XX' },
    refreshToken: { type: String, default: '' },
    lwaClientId: { type: String, default: '' },
    lwaClientSecret: { type: String, default: '' },
    region: { type: String, default: 'eu-west-1' },
    connectedAt: { type: Date },
    lastSyncAt: { type: Date },
    lastTokenRefreshAt: { type: Date },
    lastInventoryPullAt: { type: Date },
    needsReauth: { type: Boolean, default: false },
  },
  inventoryTruthEmailSentAt: { type: Date },
  inventoryConfig: {
    defaultTruthSource: {
      type: String,
      enum: ['ledger', 'shopify', 'amazon_fba', 'amazon_combined'],
      default: 'ledger',
    },
    amazonInventoryPullHours: { type: Number, default: 4 },
    fbaPullEnabled: { type: Boolean, default: true },
  },
  meeshoConfig: {
    accessToken: { type: String, default: '' },
    apiKey: { type: String, default: '' },
    connectedAt: { type: Date },
    lastSyncAt: { type: Date },
  },
  flipkartConfig: {
    apiKey: { type: String, default: '' },
    apiSecret: { type: String, default: '' },
    connectedAt: { type: Date },
    lastSyncAt: { type: Date },
  },
  /** gid://shopify/WebPixel/… from webPixelCreate / webPixelUpdate */
  shopifyWebPixelId: { type: String, default: "" },
  shopifyWebPixelInstalledAt: { type: Date },
  shopifyWebPixelSettings: { type: mongoose.Schema.Types.Mixed, default: null },
  /** Theme.liquid Deep Pixel script tag injected via Admin API */
  shopifyThemePixelInstalledAt: { type: Date },
  /** Merchant clicked Disconnect — suppress "connected" until reinstall */
  shopifyTrackingDisabled: { type: Boolean, default: false },
  lastShopifyError: { type: String, default: "" },
  generatedDiscounts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  aiUseGeneratedDiscounts: { type: Boolean, default: false }, // AI uses latest generated discount code when true
  
  /** Phase 9: Enterprise SSO (OIDC) */
  ssoConfig: {
    enabled: { type: Boolean, default: false },
    provider: {
      type: String,
      enum: ['okta', 'azuread', 'google_workspace', 'generic_oidc', ''],
      default: '',
    },
    issuerUrl: { type: String, default: '' },
    clientId: { type: String, default: '' },
    clientSecret: { type: String, default: '' },
    domainsAllowlist: { type: [String], default: [] },
    defaultRole: { type: String, enum: ['AGENT', 'CLIENT_ADMIN'], default: 'AGENT' },
    provisionedUsers: { type: Boolean, default: true },
    enforced: { type: Boolean, default: false },
  },

  // Phase 3: Operational Admin Alerts
  adminAlertWhatsapp: { type: String, default: "" }, // comma separated numbers
  /** Primary business / billing contact email (also used as fallback for alert email). */
  adminEmail: { type: String, default: "" },
  /**
   * Where to deliver flow-triggered admin escalations (human handoff, returns, B2B).
   * Per-node `admin_alert` may still override with explicit alertChannel when set.
   */
  adminAlertPreferences: {
    type: String,
    enum: ["whatsapp", "email", "both"],
    default: "both",
  },
  testMessageSent: { type: Boolean, default: false },
  wabaDisplayName: { type: String, default: "" },
  shopifyWebhooks: { type: mongoose.Schema.Types.Mixed, default: {} },
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
    enum: ["shopify", "manual"],
    default: "shopify"
  },

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
  /** When true, wizard launch creates separate main + automation flows (not one mega canvas). */
  /** When true, wizard uses ecommerce pack (one publishable flow + in-canvas folders). */
  commerceFlowPack:    { type: Boolean, default: true },

  // Phase 32: Full-screen New-User Onboarding (Instantly / Bitespeed inspired)
  // Gates the dashboard. Set to true only when user finishes Step 7 (Enter Dashboard)
  // in the new OnboardingLayout. Existing users must be migrated to `true` so they
  // are not forced into the new flow.
  onboardingCompleted:   { type: Boolean, default: false },
  onboardingStartedAt:   { type: Date, default: null },
  onboardingCompletedAt: { type: Date, default: null },
  onboardingStep:        { type: Number, default: 0, min: 0, max: 6 }, // 0-indexed; completes at step 5 sentinel
  onboardingSkipped:     { type: Boolean, default: false },
  onboardingSkippedAt:   { type: Date, default: null },
  onboardingData: {
    // Step 0: Goals
    goals: { type: [String], default: [] }, // e.g. ["abandoned_cart", "order_status", "support_bot"]
    // Step 1: Business
    brandName: { type: String, default: "" },
    websiteUrl: { type: String, default: "" },
    /** @deprecated Prefer ecommerceCategories for new signups — kept for legacy records */
    industry: { type: String, default: "" },
    /** Ecommerce product categories (workspace profile / AI personalization) */
    ecommerceCategories: { type: [String], default: [] },
    conversationVolume: { type: String, default: "" }, // "<500" | "500-2k" | "2k-10k" | "10k+"
    // Step 2: AI analysis output (what the scrape found)
    brandProfile: {
      brandColor: { type: String, default: "" },
      logoUrl: { type: String, default: "" },
      siteName: { type: String, default: "" },
      tagline: { type: String, default: "" },
      brandTone: { type: String, default: "" },
      productCategory: { type: String, default: "" },
      keySellingPoints: { type: [String], default: [] },
      detectedLanguage: { type: String, default: "" },
      scraped: { type: Boolean, default: false }
    },
    // Step 3: Integrations
    whatsappSkipped: { type: Boolean, default: false },
    // Step 4: Persona
    brandVoice: { type: String, default: "" }, // "friendly_warm" | "professional_direct" | ...
    primaryGoal: { type: String, default: "" }, // "answer_questions" | "recover_carts" | ...
    fallbackBehavior: { type: String, default: "" }, // "ask_more" | "transfer_human" | "apologize_log"
    // Step 5: Generated flow ref
    generatedFlowId: { type: String, default: "" },
    generatedFlowName: { type: String, default: "" },
    /** Commerce Form → Flow wizard: step-1 snapshot (brand, support, industry) */
    step1: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    /** Nested feature toggles from Commerce wizard (browseProducts, orderTracking, …) */
    features: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    /** Admin notification preferences from Commerce wizard */
    adminAlerts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // Analytics meta
    stepTimings: { type: mongoose.Schema.Types.Mixed, default: {} } // { "0": secondsSpent, "1": secondsSpent, ... }
  },

  // New Dedicated IG Automation Fields
  igPageId: { type: String, default: null },
  igUserId: { type: String, default: null },
  igUsername: { type: String, default: null },
  igProfilePicUrl: { type: String, default: null },
  igAccessToken: { type: String, default: null },
  igTokenExpiry: { type: Date, default: null },
  igWebhookSubscribed: { type: Boolean, default: false },
  // Snapshot of the most recent successful subscribed_fields list returned by
  // Meta. Used by ensureWebhookSubscription() to decide whether the existing
  // subscription covers the canonical REQUIRED_IG_WEBHOOK_FIELDS or whether
  // a re-subscribe is needed (e.g. after we add a new field like `comments`).
  igSubscribedFields: { type: [String], default: [] },
  igWebhookLastCheckedAt: { type: Date, default: null },
  igWebhookLastError: { type: String, default: null },
  
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
  /** Phase 4 — per-slot brand overrides (header/body for push, mappings for send). Key = catalog slot id. */
  templateBrandOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
  
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
  trialEndsAt:   { type: Date,    default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) },
  isPaidAccount: { type: Boolean, default: false },
  suspendedAt:   { type: Date },

  // Phase 17 Usage Tracking — removed Client.usage (Phase 6); use Subscription.usageThisPeriod only
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
  automationRules: { type: [mongoose.Schema.Types.Mixed], default: [] }, // deprecated — use behaviorRules + KeywordTrigger
  behaviorRules: { type: [mongoose.Schema.Types.Mixed], default: [] },
  onboarding: { type: mongoose.Schema.Types.Mixed, default: null },
  /** Legacy setup wizard state (migrated from OnboardingWizard collection — Phase 6 closeout) */
  wizardState: { type: mongoose.Schema.Types.Mixed, default: null },
  routingRules: { type: [mongoose.Schema.Types.Mixed], default: [] }, // { id, priority, conditions, fallbackAgentId, agentIds, routeType }

  // Phase 24: Meta Ads Manager
  metaAdsConnected:    { type: Boolean, default: false },
  metaAdAccountId:     { type: String, default: '' },
  metaAdsToken:        { type: String, default: '' },
  metaAdsTokenExpiry:  { type: Date },
  metaAdsAccountName:  { type: String, default: '' },

  // Phase 24: WhatsApp Catalog
  waCatalogId:         { type: String, default: '' },
  /** Meta Commerce Manager catalog id (alias of waCatalogId; WhatsApp product_list uses this) */
  facebookCatalogId:   { type: String, default: '' },
  /** System User or Business token with catalog_management — required to import products via Graph API */
  metaCatalogAccessToken: { type: String, default: '' },
  facebookPageId:      { type: String, default: '' },
  shopifyStorefrontToken: { type: String, default: '' },
  shopifyLastProductSync: { type: Date },
  /** Count of indexed variant rows (Shopify → Mongo sync for Flow Builder) */
  shopifyProductCount: { type: Number, default: 0 },
  shopifyCollectionCount: { type: Number, default: 0 },
  shopifySyncInProgress: { type: Boolean, default: false },
  shopifySyncLastError:  { type: String, default: '' },
  commerceEnabled:     { type: Boolean, default: false },
  catalogSynced:       { type: Boolean, default: false },
  commerceAutoSyncDaily: { type: Boolean, default: false },
  catalogSyncedAt:     { type: Date },
  inventoryTruthPreNoticeAt: { type: Date },
  inventoryTruthShippedAt: { type: Date },
  customersSyncedAt: { type: Date, default: null },
  shopifyCustomersCache: { type: [mongoose.Schema.Types.Mixed], default: [] },
  shopifyCustomersCacheCount: { type: Number, default: 0 },
  catalogProductCount: { type: Number, default: 0 },
  catalogEnabled:      { type: Boolean, default: false },
  commerceBotSettings: {
    checkoutMessage: { type: String, default: '' },
    cartReminderDelay: { type: Number, default: 30 },
    cartReminderMessage: { type: String, default: '' },
    catalogWelcomeMessage: { type: String, default: '' },
    showCatalogOnFirstMessage: { type: Boolean, default: false }
  },

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
    actionType: { type: String, enum: ['message', 'sequence'], default: 'message' },
    templateName: { type: String }, 
    sequenceId: { type: String },
    language: { type: String, default: 'en' },
    triggerEvent: { type: String, enum: ['paid', 'shipped', 'abandoned', 'stock_alert'], default: 'paid' },
    delayMinutes: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    description: String,
    imageUrl: String, // Optional override image
    inventoryThreshold: { type: Number, default: 0 },
    supplierPhone: { type: String, default: "" }
  }],

  // Unified Shopify automation center schema (SKU + order status in one place)
  commerceAutomations: { type: [mongoose.Schema.Types.Mixed], default: [] },
  commerceAutomationVersion: { type: Number, default: 0 },
  commerceAutomationMigratedAt: { type: Date, default: null },
  commerceAutomationLegacySnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Warranty legacy migration tracking (admin/reporting)
  warrantyMigrationStatus: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Phase 29: Dashboard Personalization
  dashboardConfig: {
    layout: { type: [mongoose.Schema.Types.Mixed], default: [] }, // [{ id, x, y, w, h, i }]
    hiddenWidgets: { type: [String], default: [] }
  },

  // NOTE: The Phase 29 `ai:` block previously lived here but has been MERGED
  // into AiSchema at the top of this file. Mongoose silently overrode the
  // first `ai` definition with this duplicate, killing geminiKey / openaiKey /
  // systemPrompt / fallbackEnabled / voice settings. See AiSchema for the
  // canonical home of persona / trainingData / supplierAlerts.

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
  }
  // NOTE: trailing duplicate `createdAt` removed — defined once near top.
});

function encryptSubDocs(doc) {
  const isEnc = (val) => {
    if (typeof val !== 'string') return false;
    const parts = val.split(':');
    return parts.length === 2 && parts[0].length === 32;
  };

  const enc = (val) => {
    if (typeof val !== 'string' || isEnc(val)) return val;
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
  if (doc.ai?.geminiKey) doc.ai.geminiKey = enc(doc.ai.geminiKey);
  if (doc.ai?.openaiKey) doc.ai.openaiKey = enc(doc.ai.openaiKey);
  if (doc.social?.instagram?.accessToken) doc.social.instagram.accessToken = enc(doc.social.instagram.accessToken);
  if (doc.social?.instagram?.appSecret) doc.social.instagram.appSecret = enc(doc.social.instagram.appSecret);
  if (doc.social?.metaAds?.accessToken) doc.social.metaAds.accessToken = enc(doc.social.metaAds.accessToken);
  
  // Legacy Encryptions
  if (doc.whatsappToken) doc.whatsappToken = enc(doc.whatsappToken);
  if (doc.metaCatalogAccessToken) doc.metaCatalogAccessToken = enc(doc.metaCatalogAccessToken);
  if (doc.shopifyAccessToken) doc.shopifyAccessToken = enc(doc.shopifyAccessToken);
  if (doc.shopifyRefreshToken) doc.shopifyRefreshToken = enc(doc.shopifyRefreshToken);
  if (doc.shopifyWebhookSecret) doc.shopifyWebhookSecret = enc(doc.shopifyWebhookSecret);
  if (doc.shopifyClientSecret) doc.shopifyClientSecret = enc(doc.shopifyClientSecret);
  if (doc.geminiApiKey) doc.geminiApiKey = enc(doc.geminiApiKey);
  if (doc.openaiApiKey) doc.openaiApiKey = enc(doc.openaiApiKey);
  if (doc.instagramAccessToken) doc.instagramAccessToken = enc(doc.instagramAccessToken);
  if (doc.instagramAppSecret) doc.instagramAppSecret = enc(doc.instagramAppSecret);
  if (doc.igAccessToken) doc.igAccessToken = enc(doc.igAccessToken);
  if (doc.razorpaySecret) doc.razorpaySecret = enc(doc.razorpaySecret);
  if (doc.cashfreeSecretKey) doc.cashfreeSecretKey = enc(doc.cashfreeSecretKey);
  if (doc.stripeSecretKey) doc.stripeSecretKey = enc(doc.stripeSecretKey);
  if (doc.payuMerchantSalt) doc.payuMerchantSalt = enc(doc.payuMerchantSalt);
  if (doc.phonepeSaltKey) doc.phonepeSaltKey = enc(doc.phonepeSaltKey);
  if (doc.emailAppPassword) doc.emailAppPassword = enc(doc.emailAppPassword);
  if (doc.amazonConfig?.refreshToken) {
    doc.amazonConfig.refreshToken = enc(doc.amazonConfig.refreshToken);
  }
  if (doc.amazonConfig?.lwaClientSecret) {
    doc.amazonConfig.lwaClientSecret = enc(doc.amazonConfig.lwaClientSecret);
  }
  if (Array.isArray(doc.shopifyStores)) {
    doc.shopifyStores.forEach((store) => {
      if (store?.accessToken) store.accessToken = enc(store.accessToken);
    });
  }
}

function syncSocialFields(doc) {
  // Sync Instagram
  if (doc.instagramConnected !== undefined) {
    if (!doc.social) doc.social = { instagram: {} };
    if (!doc.social.instagram) doc.social.instagram = {};
    doc.social.instagram.connected = doc.instagramConnected;
  }
  if (doc.instagramAccessToken) {
    if (!doc.social) doc.social = { instagram: {} };
    if (!doc.social.instagram) doc.social.instagram = {};
    doc.social.instagram.accessToken = doc.instagramAccessToken;
  }
  if (doc.instagramPageId) {
    if (!doc.social) doc.social = { instagram: {} };
    if (!doc.social.instagram) doc.social.instagram = {};
    doc.social.instagram.pageId = doc.instagramPageId;
  }
  if (doc.instagramUsername) {
    if (!doc.social) doc.social = { instagram: {} };
    if (!doc.social.instagram) doc.social.instagram = {};
    doc.social.instagram.username = doc.instagramUsername;
  }

  // Reverse sync (modular to legacy)
  if (doc.social?.instagram?.connected !== undefined) {
    doc.instagramConnected = doc.social.instagram.connected;
    if (doc.social.instagram.connected) doc.instagramConnected = true;
  }
  if (doc.social?.instagram?.accessToken) {
    doc.instagramAccessToken = doc.social.instagram.accessToken;
  }
  if (doc.social?.instagram?.pageId) {
    doc.instagramPageId = doc.social.instagram.pageId;
  }
  if (doc.social?.instagram?.username) {
    doc.instagramUsername = doc.social.instagram.username;
  }

  // Sync Meta Ads
  if (doc.metaAdsConnected !== undefined) {
    if (!doc.social) doc.social = { metaAds: {} };
    if (!doc.social.metaAds) doc.social.metaAds = {};
    doc.social.metaAds.connected = doc.metaAdsConnected;
  }
  if (doc.metaAdsToken) {
    if (!doc.social) doc.social = { metaAds: {} };
    if (!doc.social.metaAds) doc.social.metaAds = {};
    doc.social.metaAds.accessToken = doc.metaAdsToken;
  }
  if (doc.metaAdAccountId) {
    if (!doc.social) doc.social = { metaAds: {} };
    if (!doc.social.metaAds) doc.social.metaAds = {};
    doc.social.metaAds.accountId = doc.metaAdAccountId;
  }
}

function encryptUpdateQuery(update) {
  if (!update) return;
  const setOps = update.$set || update;
  
  const isEnc = (val) => {
    if (typeof val !== 'string') return false;
    const parts = val.split(':');
    return parts.length === 2 && parts[0].length === 32;
  };

  const enc = (val) => {
    if (typeof val !== 'string' || isEnc(val)) return val;
    try {
      return encrypt(val);
    } catch (e) {
      return val;
    }
  };
  
  const encPaths = [
    'whatsapp.accessToken', 'commerce.shopify.accessToken', 'commerce.shopify.refreshToken', 'commerce.shopify.clientSecret', 'commerce.shopify.webhookSecret',
    'ai.geminiKey', 'ai.openaiKey', 'social.instagram.accessToken', 'social.instagram.appSecret', 'social.metaAds.accessToken',
    'whatsappToken', 'metaCatalogAccessToken', 'shopifyAccessToken', 'shopifyRefreshToken', 'shopifyWebhookSecret', 'shopifyClientSecret',
    'geminiApiKey', 'openaiApiKey', 'instagramAccessToken', 
    'instagramAppSecret', 'igAccessToken', 'razorpaySecret', 'cashfreeSecretKey', 'stripeSecretKey', 
    'payuMerchantSalt', 'phonepeSaltKey', 'emailAppPassword', 'whatsappRegistrationPin'
  ];

  for (const path of encPaths) {
    if (setOps[path]) setOps[path] = enc(setOps[path]);
  }

  // Also sync fields in update query
  if (setOps.instagramConnected !== undefined) setOps['social.instagram.connected'] = setOps.instagramConnected;
  if (setOps['social.instagram.connected'] !== undefined) setOps.instagramConnected = setOps['social.instagram.connected'];
  
  if (setOps.instagramAccessToken) setOps['social.instagram.accessToken'] = enc(setOps.instagramAccessToken);
  if (setOps['social.instagram.accessToken']) setOps.instagramAccessToken = enc(setOps['social.instagram.accessToken']);

  if (setOps.instagramPageId) setOps['social.instagram.pageId'] = setOps.instagramPageId;
  if (setOps['social.instagram.pageId']) setOps.instagramPageId = setOps['social.instagram.pageId'];

  if (setOps.instagramUsername) setOps['social.instagram.username'] = setOps.instagramUsername;
  if (setOps['social.instagram.username']) setOps.instagramUsername = setOps['social.instagram.username'];

  if (Array.isArray(setOps.shopifyStores)) {
    setOps.shopifyStores = setOps.shopifyStores.map((store) => {
      if (!store || typeof store !== 'object') return store;
      const next = { ...store };
      if (next.accessToken) next.accessToken = enc(next.accessToken);
      return next;
    });
  }
}

ClientSchema.pre('save', function(next) {
  syncSocialFields(this);
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
