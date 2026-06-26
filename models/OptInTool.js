const mongoose = require('mongoose');

const prizeSchema = new mongoose.Schema(
  {
    label: { type: String, default: '' },
    couponMode: { type: String, enum: ['unique', 'fixed', 'lose'], default: 'fixed' },
    couponCode: { type: String, default: '' },
    discountType: { type: String, enum: ['percentage', 'fixed_amount'], default: 'percentage' },
    discountValue: { type: Number, default: 10 },
    minimumOrderAmount: { type: Number, default: 0 },
    probability: { type: Number, default: 0 },
    shopifyPriceRuleId: { type: String, default: '' },
    autoCreateOnShopify: { type: Boolean, default: true },
  },
  { _id: true }
);

const dayRollupSchema = new mongoose.Schema(
  {
    total: { type: Number, default: 0 },
    byDay: { type: Map, of: Number, default: () => new Map() },
  },
  { _id: false }
);

const optInToolSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, default: 'Untitled tool' },
  type: {
    type: String,
    enum: ['whatsapp_widget', 'popup', 'spin_wheel', 'mystery_discount'],
    required: true,
  },
  status: { type: String, enum: ['draft', 'live'], default: 'draft', index: true },
  templateId: { type: String, default: '' },

  design: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },

  triggers: {
    when: {
      condition: {
        type: String,
        enum: ['immediate', 'delay', 'exit_intent', 'scroll_depth', 'time_on_page', 'add_to_cart'],
        default: 'delay',
      },
      delaySeconds: { type: Number, default: 3 },
      scrollDepth: { type: Number, default: 50 },
      timeOnPage: { type: Number, default: 0 },
    },
    where: {
      pagesToShow: { type: [String], default: () => ['all'] },
      pagesToHide: { type: [String], default: () => [] },
      devices: { type: [String], default: () => ['all'] },
    },
    who: {
      visitorType: {
        type: String,
        enum: ['all', 'new', 'returning', 'not_subscribed'],
        default: 'all',
      },
    },
    frequency: {
      type: {
        type: String,
        enum: ['once_ever', 'once_per_session', 'once_per_day', 'every_visit'],
        default: 'once_per_session',
      },
      cooldownDays: { type: Number, default: 3 },
    },
    schedule: {
      enabled: { type: Boolean, default: false },
      timezone: { type: String, default: 'Asia/Kolkata' },
      days: { type: [Number], default: () => [1, 2, 3, 4, 5, 6] },
      startHour: { type: Number, default: 9, min: 0, max: 23 },
      endHour: { type: Number, default: 21, min: 0, max: 23 },
    },
    smart: {
      enabled: { type: Boolean, default: false },
      browsingWithoutAction: { enabled: { type: Boolean, default: false }, threshold: { type: Number, default: 3 } },
      productPageDwell: { enabled: { type: Boolean, default: false }, seconds: { type: Number, default: 30 } },
      cartWithoutCheckout: { enabled: { type: Boolean, default: false }, minutes: { type: Number, default: 5 } },
      returnVisitor: { enabled: { type: Boolean, default: false } },
      highValueBrowser: { enabled: { type: Boolean, default: false }, thresholdAmount: { type: Number, default: 5000 } },
    },
  },

  prizes: { type: [prizeSchema], default: () => [] },
  mysteryRevealType: { type: String, enum: ['scratch', 'tap_hold'], default: 'scratch' },

  sendWhatsAppWelcome: { type: Boolean, default: true },
  welcomeTemplateSlot: { type: String, default: 'optin_welcome_v1' },

  thankYouConfig: {
    showBestsellers: { type: Boolean, default: true },
    shopNowUrl: { type: String, default: '' },
    socialLinks: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },

  impressions: { type: dayRollupSchema, default: () => ({ total: 0, byDay: {} }) },
  signups: { type: dayRollupSchema, default: () => ({ total: 0, byDay: {} }) },
  couponRedemptions: { type: dayRollupSchema, default: () => ({ total: 0, byDay: {} }) },

  analytics: {
    topPages: { type: Map, of: Number, default: () => new Map() },
    devices: {
      mobile: { type: Number, default: 0 },
      desktop: { type: Number, default: 0 },
    },
    prizeWins: { type: Map, of: Number, default: () => new Map() },
  },

  couponPool: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
  themeInjectVersion: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

optInToolSchema.index({ clientId: 1, status: 1 });
optInToolSchema.index({ clientId: 1, type: 1 });

optInToolSchema.pre('save', function preSave(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('OptInTool', optInToolSchema);
