const mongoose = require('mongoose');

const ActorSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['user', 'lead', 'system', 'super_admin'],
      required: true,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', default: null },
    source: { type: String, default: '' }, // dashboard | unsubscribe_link | stop_keyword | cron:...
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { _id: false }
);

const auditLogSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  /** Legacy dashboard actor — optional for new writes; kept for backward reads. */
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  actor: { type: ActorSchema, default: null },
  category: {
    type: String,
    index: true,
    default: 'general',
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'high', 'critical'],
    default: 'info',
  },
  action_type: {
    type: String,
    required: true,
    index: true,
  }, // EXPORT_LEADS | force_send | login_success | unauthorized_cross_tenant_attempt | ...
  target_resource: { type: String },
  ip_address: { type: String },
  userAgent: { type: String },
  payload: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, index: true },
});

auditLogSchema.index({ clientId: 1, 'actor.type': 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
