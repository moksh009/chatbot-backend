const mongoose = require('mongoose');

const KINDS = [
  'error',
  'api_failure',
  'api_error',
  'page_view',
  'feature_click',
  'hub_tab_view',
  'funnel_step',
  'server_error',
];

const clientTelemetryEventSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  sessionId: { type: String, index: true },
  kind: { type: String, required: true, enum: KINDS, index: true },
  feature: { type: String, index: true },
  route: { type: String },
  message: { type: String },
  stack: { type: String },
  httpStatus: { type: Number },
  httpMethod: { type: String },
  apiPath: { type: String },
  userAgent: { type: String },
  browser: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
  fingerprint: { type: String, index: true },
  createdAt: { type: Date, default: Date.now, expires: '90d' },
});

clientTelemetryEventSchema.index({ clientId: 1, createdAt: -1 });
clientTelemetryEventSchema.index({ kind: 1, createdAt: -1 });
clientTelemetryEventSchema.index({ fingerprint: 1, clientId: 1, createdAt: -1 });

module.exports = mongoose.model('ClientTelemetryEvent', clientTelemetryEventSchema);
module.exports.TELEMETRY_KINDS = KINDS;
