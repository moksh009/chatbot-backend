const mongoose = require('mongoose');

const FollowUpSequenceSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', required: true },
  phone: { type: String },
  email: { type: String },
  name: { type: String, default: 'Untitled Sequence' },
  type: {
    type: String,
    enum: [
      'custom',
      'review_request',
      'abandoned_cart',
      'warranty_resend',
      'warranty_certificate',
      'post_purchase_journey',
    ],
    default: 'custom',
  },
  playbookKey: { type: String, default: '' },
  sourceOrderId: { type: String, default: '' },
  sourceFlowId: { type: String, default: '' },
  /** How / why this sequence was started; blueprint fields reserved for future auto-enrollment workers */
  enrollment: {
    mode: { type: String, enum: ['instant', 'blueprint'], default: 'instant' },
    blueprint: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  status: { type: String, enum: ["active", "completed", "cancelled", "paused"], default: "active" },
  /** When true (default), inbound customer reply cancels remaining steps. */
  cancelOnReply: { type: Boolean, default: true },
  cancelledReason: { type: String },
  cancelledAt: { type: Date },
  steps: [{
    type: {
      type: String,
      enum: ['whatsapp', 'email', 'review_request', 'warranty_resend', 'flow_handoff'],
      default: 'whatsapp',
    },
    /** Journey chatbot handoff — published Flow Builder flow id */
    targetFlowId: { type: String, default: '' },
    targetFlowName: { type: String, default: '' },
    templateId: String, // For Meta WhatsApp Templates
    templateName: String,
    subject: String, // For Email
    content: String, // For Email or Custom Text
    delayValue: Number, // Value (e.g. 15)
    delayUnit: { type: String, enum: ['m', 'h', 'd'], default: 'm' },
    sendAt: Date,
    status: {
      type: String,
      enum: ['queued', 'pending', 'processing', 'retrying', 'sent', 'failed', 'cancelled', 'skipped'],
      default: 'pending',
    },
    lockedBy: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    skipReason: { type: String, default: null },
    sentAt: Date,
    errorLog: String,
    condition: String,
    mediaType: { type: String, enum: ['none', 'static', 'dynamic'], default: 'none' },
    mediaUrl: String,
    /** When true, sendAt matches previous step (same beat as WhatsApp + email) */
    parallelWithPrevious: { type: Boolean, default: false },
    /** Journey Phase 2 — interactive step fields */
    interactionMode: {
      type: String,
      enum: ['none', 'awaiting_button', 'awaiting_text'],
      default: 'none',
    },
    /** Expected button payload IDs for this step (e.g. ['cod_confirm', 'cod_cancel']) */
    expectedActions: { type: [String], default: [] },
    /** Arbitrary context for this step (e.g. { orderId, codConfirmRequested: true }) */
    context: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Phase 4 — WA Graph message id for webhook backfill */
    messageId: { type: String, default: '' },
    /** Phase 4 — email envelope for open/click tracking */
    envelopeId: { type: mongoose.Schema.Types.ObjectId, default: null },
    channel: { type: String, enum: ['whatsapp', 'email'], default: 'whatsapp' },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    clickedAt: { type: Date, default: null },
    clickType: { type: String, enum: ['button', 'link', ''], default: '' },
  }]
}, { timestamps: true });

FollowUpSequenceSchema.index({ status: 1, "steps.sendAt": 1 });
FollowUpSequenceSchema.index({ clientId: 1, status: 1 });
/** Active sequences per lead — speeds enrollment checks + cron */
FollowUpSequenceSchema.index({ clientId: 1, leadId: 1, status: 1 });
FollowUpSequenceSchema.index({ clientId: 1, sourceFlowId: 1, createdAt: -1 });

FollowUpSequenceSchema.pre('validate', function followUpLeadIdGuard() {
  if (!this.leadId) {
    this.invalidate('leadId', 'leadId is required for FollowUpSequence enrollment');
  }
});

module.exports = mongoose.model('FollowUpSequence', FollowUpSequenceSchema);
