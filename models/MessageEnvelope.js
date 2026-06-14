const mongoose = require('mongoose');

const messageEnvelopeSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', default: null },
    channel: { type: String, enum: ['whatsapp', 'instagram', 'email'], required: true },
    intent: {
      type: String,
      enum: ['marketing', 'utility', 'authentication', 'service', 'transactional'],
      required: true,
    },
    status: {
      type: String,
      enum: ['sent', 'queued', 'blocked', 'duplicate', 'failed'],
      required: true,
    },
    blockedBy: {
      type: String,
      enum: [
        'consent',
        'suppression',
        'rate_limit',
        'plan_limit',
        'template_not_approved',
        'meta_rate',
        'idempotency',
        'window_closed',
        'invalid_contact',
        'channel_disabled',
      ],
      default: null,
    },
    reason: { type: String, default: '' },
    templateName: { type: String, default: '' },
    idempotencyKey: { type: String, required: true },
    context: { type: mongoose.Schema.Types.Mixed, default: {} },
    messageId: { type: String, default: '' },
    consentSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    tracking: {
      openCount: { type: Number, default: 0 },
      clickCount: { type: Number, default: 0 },
      firstOpenAt: { type: Date, default: null },
      lastOpenAt: { type: Date, default: null },
      bounced: { type: Boolean, default: false },
      bouncedAt: { type: Date, default: null },
      unsubscribed: { type: Boolean, default: false },
      unsubscribedAt: { type: Date, default: null },
    },
  },
  { minimize: false }
);

messageEnvelopeSchema.index({ clientId: 1, contactId: 1, createdAt: -1 });
messageEnvelopeSchema.index({ idempotencyKey: 1 }, { unique: true });

module.exports = mongoose.model('MessageEnvelope', messageEnvelopeSchema);
