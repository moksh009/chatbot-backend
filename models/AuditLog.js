const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action_type: { type: String, required: true }, // e.g., 'EXPORT_LEADS', 'DELETE_FLOW', 'WEBHOOK_REPLAY'
  target_resource: { type: String },
  ip_address: { type: String },
  userAgent: { type: String },
  payload: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, expires: '90d' }
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
