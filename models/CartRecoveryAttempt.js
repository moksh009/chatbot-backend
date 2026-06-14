const mongoose = require('mongoose');

const WhatsappTemplateSentSchema = new mongoose.Schema(
  {
    templateName: { type: String, default: '' },
    sentAt: { type: Date, default: Date.now },
    followupNumber: { type: Number, default: 0 },
    messageId: { type: String, default: '' },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    clickedAt: { type: Date, default: null },
    clickType: { type: String, enum: ['link', 'button', null], default: null },
  },
  { _id: false }
);

const CartRecoveryAttemptSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', default: null },
  contactPhone: { type: String, required: true },
  checkoutToken: { type: String, default: '', index: true },
  cartToken: { type: String, default: '' },
  attemptTimestamp: { type: Date, default: Date.now },
  lastSendFailure: {
    step: { type: Number, default: 0 },
    reason: { type: String, default: '' },
    detail: { type: String, default: '' },
    at: { type: Date, default: null },
  },
  messaged: { type: Boolean, default: false },
  recovered: { type: Boolean, default: false },
  recoveryStep: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'recovered', 'expired'], default: 'pending' },
  whatsappMessageSentAt: { type: Date, default: null },
  whatsappTemplatesSent: { type: [WhatsappTemplateSentSchema], default: [] },
  recoveredViaWhatsapp: { type: Boolean, default: false },
  organicRecovery: { type: Boolean, default: false },
  recoveredOrderId: { type: String, default: null },
  recoveredOrderValue: { type: Number, default: null },
  recoveredOrderAmount: { type: Number, default: null },
  /** Revenue attributed to this recovery attempt (Phase 4) */
  attributedRevenue: { type: Number, default: null },
  attributedAt: { type: Date, default: null },
  recoveredAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

CartRecoveryAttemptSchema.index({ clientId: 1, contactPhone: 1, status: 1 });
CartRecoveryAttemptSchema.index({ clientId: 1, checkoutToken: 1, status: 1 }, { sparse: true });
CartRecoveryAttemptSchema.index({ clientId: 1, whatsappMessageSentAt: 1 });
CartRecoveryAttemptSchema.index({ clientId: 1, leadId: 1, status: 1 });
CartRecoveryAttemptSchema.index({ clientId: 1, attemptTimestamp: 1 });
CartRecoveryAttemptSchema.index({ clientId: 1, status: 1, recoveredAt: 1 });

module.exports = mongoose.model('CartRecoveryAttempt', CartRecoveryAttemptSchema);
