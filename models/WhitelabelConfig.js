const mongoose = require('mongoose');

const whitelabelConfigSchema = new mongoose.Schema({
  resellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Branding
  productName:    { type: String, default: 'TopEdge AI' },
  logoUrl:        { type: String, default: '' },
  faviconUrl:     { type: String, default: '' },
  primaryColor:   { type: String, default: '#4F46E5' },
  accentColor:    { type: String, default: '#7C3AED' },
  loginBgColor:   { type: String, default: '#F1F5F9' },
  loginBgImage:   { type: String, default: '' },

  // Domain
  customDomain:     { type: String, default: '', lowercase: true, trim: true },
  domainVerified:   { type: Boolean, default: false },
  domainVerifiedAt: { type: Date },
  sslProvisioned:   { type: Boolean, default: false },

  // Email (notifications from reseller's domain)
  emailFromName:    { type: String, default: '' },
  emailFromAddress: { type: String, default: '' },
  smtpHost:         { type: String, default: '' },
  smtpPort:         { type: Number, default: 587 },
  smtpUser:         { type: String, default: '' },
  smtpPass:         { type: String, default: '' },

  // Attribution
  showPoweredBy:    { type: Boolean, default: false },
  supportEmail:     { type: String, default: '' },
  supportPhone:     { type: String, default: '' },
  privacyPolicyUrl: { type: String, default: '' },
  termsUrl:         { type: String, default: '' },

  // Plan name overrides — reseller can rename TopEdge plans for their clients
  planOverrides: [{
    originalPlan: { type: String },  // "starter"
    displayName:  { type: String },  // "Basic"
    displayPrice: { type: String },  // "₹1,499/mo"
    isVisible:    { type: Boolean, default: true }
  }],

  isActive:  { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

whitelabelConfigSchema.index({ customDomain: 1 });
whitelabelConfigSchema.index({ resellerId: 1 });

module.exports = mongoose.model('WhitelabelConfig', whitelabelConfigSchema);
