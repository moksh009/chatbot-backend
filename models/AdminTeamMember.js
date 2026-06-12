const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const PERMISSION_DEFAULTS = {
  viewClients: false,
  editClients: false,
  createClients: false,
  deleteClients: false,
  viewSensitiveKeys: false,
  grantVIP: false,
  suspendClients: false,
  assignPlans: false,
  viewSupportChats: false,
  replySupportChats: false,
  takeoverChats: false,
  viewMetrics: false,
  viewErrors: false,
  viewAuditLog: false,
  manageTemplates: false,
  bulkPushTemplates: false,
  viewDeadLetters: false,
  retryDeadLetters: false,
  manageTeam: false,
};

const ROLE_TEMPLATES = {
  SUPER_ADMIN: Object.fromEntries(Object.keys(PERMISSION_DEFAULTS).map((k) => [k, true])),
  SUPPORT: {
    ...PERMISSION_DEFAULTS,
    viewClients: true,
    viewSupportChats: true,
    replySupportChats: true,
    takeoverChats: true,
    viewErrors: true,
  },
  OPERATIONS: {
    ...PERMISSION_DEFAULTS,
    viewClients: true,
    editClients: true,
    assignPlans: true,
    viewMetrics: true,
    manageTemplates: true,
    bulkPushTemplates: true,
  },
  VIEWER: {
    ...PERMISSION_DEFAULTS,
    viewClients: true,
    viewMetrics: true,
    viewErrors: true,
    viewAuditLog: true,
  },
};

const adminTeamMemberSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  passwordHash: { type: String, default: '' },
  role: {
    type: String,
    enum: ['SUPER_ADMIN', 'SUPPORT', 'OPERATIONS', 'VIEWER'],
    default: 'VIEWER',
  },
  permissions: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({ ...PERMISSION_DEFAULTS }),
  },
  allowedClientIds: { type: [String], default: [] },
  lastLoginAt: { type: Date },
  lastLoginIp: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  inviteToken: { type: String, default: '' },
  inviteExpiresAt: { type: Date },
}, { timestamps: true });

adminTeamMemberSchema.methods.matchPassword = async function matchPassword(entered) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(entered, this.passwordHash);
};

adminTeamMemberSchema.statics.applyRoleTemplate = function applyRoleTemplate(role) {
  return { ...(ROLE_TEMPLATES[role] || ROLE_TEMPLATES.VIEWER) };
};

module.exports = mongoose.model('AdminTeamMember', adminTeamMemberSchema);
module.exports.PERMISSION_DEFAULTS = PERMISSION_DEFAULTS;
module.exports.ROLE_TEMPLATES = ROLE_TEMPLATES;
