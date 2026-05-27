const mongoose = require('mongoose');

const WhatsappTemplateSentSchema = new mongoose.Schema(
  {
    templateName: { type: String, default: '' },
    sentAt: { type: Date, default: Date.now },
    followupNumber: { type: Number, default: 0 },
  },
  { _id: false }
);

const CartRecoveryAttemptSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', default: null },
  contactPhone: { type: String, required: true },
  attemptTimestamp: { type: Date, default: Date.now },
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
  recoveredAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

CartRecoveryAttemptSchema.index({ clientId: 1, contactPhone: 1, status: 1 });
CartRecoveryAttemptSchema.index({ clientId: 1, whatsappMessageSentAt: 1 });
CartRecoveryAttemptSchema.index({ clientId: 1, leadId: 1, status: 1 });
CartRecoveryAttemptSchema.index({ clientId: 1, attemptTimestamp: 1 });
CartRecoveryAttemptSchema.index({ clientId: 1, status: 1, recoveredAt: 1 });

module.exports = mongoose.model('CartRecoveryAttempt', CartRecoveryAttemptSchema);
