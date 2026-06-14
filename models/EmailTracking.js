const mongoose = require('mongoose');

const EmailTrackingSchema = new mongoose.Schema(
  {
    envelopeId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageEnvelope', index: true },
    clientId: { type: String, index: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', default: null },
    type: { type: String, enum: ['open', 'click', 'bounce', 'unsubscribe'], required: true },
    url: { type: String, default: '' },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

EmailTrackingSchema.index({ clientId: 1, type: 1, timestamp: -1 });
EmailTrackingSchema.index({ envelopeId: 1, type: 1 });

module.exports = mongoose.model('EmailTracking', EmailTrackingSchema);
