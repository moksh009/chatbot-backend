const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { 
    type: String, 
    enum: ['SUPER_ADMIN', 'CLIENT_ADMIN', 'AGENT', 'RECEPTIONIST', 'VIEWER'], 
    default: 'CLIENT_ADMIN' 
  },
  // Phase 24: Reseller Portal
  userType: {
    type: String,
    enum: ['client', 'agent', 'reseller', 'super_admin'],
    default: 'client'
  },
  business_type: {
    type: String,
    default: 'clinic'
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
  authProvider: { type: String, enum: ['email', 'google'], default: 'email' },
  // ── Tasks ─────────────────────────────────────────────────────────────────────
  tasks: [{
    title:       { type: String, required: true },
    description: { type: String },
    type:        { type: String, enum: ['respond_to_lead', 'review_campaign', 'fix_flow', 'custom'], default: 'custom' },
    assignedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedAt:  { type: Date, default: Date.now },
    dueAt:       { type: Date },
    status:      { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
    completedAt: { type: Date },
    linkedEntity: {
      entityType: { type: String, enum: ['conversation', 'campaign', 'flow', 'none'], default: 'none' },
      entityId:   { type: String }
    }
  }],
  createdAt: { type: Date, default: Date.now }
});

// Hash password before saving
UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Match password
UserSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);
