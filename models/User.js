const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: {
    type: String,
    required: function passwordRequired() {
      return !this.ssoSubject;
    },
    default: '',
  },
  ssoSubject: { type: String, default: '', sparse: true },
  lastLoginVia: { type: String, enum: ['password', 'sso', 'google'], default: 'password' },
  role: { 
    type: String, 
    enum: ['SUPER_ADMIN', 'CLIENT_ADMIN', 'AGENT', 'RECEPTIONIST', 'VIEWER'], 
    default: 'CLIENT_ADMIN' 
  },
  /** Sidebar section ids this agent may access (CLIENT_ADMIN / SUPER_ADMIN bypass). */
  hubAccess: {
    type: [String],
    default: undefined,
  },
  // Phase 24: Reseller Portal
  userType: {
    type: String,
    enum: ['client', 'agent', 'reseller', 'super_admin'],
    default: 'client'
  },
  business_type: {
    type: String,
    default: 'ecommerce'
  },
  clientId: { type: String, required: true }, // Tenant ID
  hasCompletedTour: { type: Boolean, default: false }, // For frontend Onboarding
  tourCompletedAt:  { type: Date },
  tourSkippedAt:    { type: Date },
  isLifetimeAdmin: { type: Boolean, default: false }, // Objective 1: God Mode Bypass
  lastAssignedTimestamp: { type: Date }, // For Round-Robin routing
  // ── Google OAuth ──────────────────────────────────────────────────────────────
  googleId: { type: String, default: '' },
  profilePicture: { type: String, default: '' },
  authProvider: { type: String, enum: ['email', 'google', 'sso'], default: 'email' },
  // ── Tasks ─────────────────────────────────────────────────────────────────────
  tasks: [{
    title:       { type: String, required: true },
    description: { type: String },
    type:        { type: String, enum: ['respond_to_lead', 'review_campaign', 'fix_flow', 'custom'], default: 'custom' },
    assignedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedAt:  { type: Date, default: Date.now },
    dueAt:       { type: Date },
    priority:    { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    status:      { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
    completedAt: { type: Date },
    linkedEntity: {
      entityType: { type: String, enum: ['conversation', 'campaign', 'flow', 'none'], default: 'none' },
      entityId:   { type: String }
    }
  }],
  /** Record of acceptance of Privacy Policy / Terms at registration (audit). */
  legal: {
    acceptedAt: { type: Date },
    docsVersion: { type: String, default: '' }
  },
  /** Dashboard telemetry: '' | essential | analytics (synced with browser localStorage) */
  telemetryConsent: {
    type: String,
    enum: ['', 'essential', 'analytics'],
    default: '',
  },
  telemetryConsentUpdatedAt: { type: Date, default: null },
  failedLoginAttempts: {
    count: { type: Number, default: 0 },
    firstAttemptAt: { type: Date, default: null },
  },
  lockedUntil: { type: Date, default: null },
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: { type: String, default: null },
  twoFactorRecoveryCodes: { type: [String], default: [] },
  /** E.164 Indian mobile — optional, captured at signup or onboarding */
  phone: { type: String, default: null },
  welcomeEmailSentAt: { type: Date, default: null },
  welcomeWhatsappSentAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

// Hash password before saving
UserSchema.pre('save', async function(next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Match password
UserSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);
