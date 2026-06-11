const mongoose = require('mongoose');

const dashboardSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  visitorKey: { type: String, required: true, index: true },
  clientId: { type: String, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now, index: true },
  lastPingAt: { type: Date, default: Date.now },
  pingCount: { type: Number, default: 1 },
  userAgent: { type: String },
  browser: { type: String },
  analyticsConsent: { type: String, enum: ['', 'essential', 'analytics'], default: '' },
  isReturning: { type: Boolean, default: false },
  priorSessionCount: { type: Number, default: 0 },
  cookieStrategy: { type: String, default: 'httpOnly_first_party' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

dashboardSessionSchema.index({ clientId: 1, lastSeen: -1 });
dashboardSessionSchema.index({ visitorKey: 1, firstSeen: -1 });
dashboardSessionSchema.index({ userId: 1, clientId: 1, firstSeen: -1 });
dashboardSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = mongoose.model('DashboardSession', dashboardSessionSchema);
