const mongoose = require('mongoose');

const EmailTemplateSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    category: {
      type: String,
      enum: ['order', 'cart_recovery', 'marketing', 'sequence', 'utility', 'custom'],
      default: 'custom',
    },
    subject: { type: String, required: true },
    bodyHtml: { type: String, required: true },
    bodyText: { type: String, default: '' },
    previewText: { type: String, default: '' },
    variables: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    tags: { type: [String], default: [] },
    sentCount: { type: Number, default: 0 },
    lastSentAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    version: { type: Number, default: 1 },
    legacyLocalId: { type: String, default: '' },
  },
  { timestamps: true }
);

EmailTemplateSchema.index({ clientId: 1, isActive: 1, category: 1 });
EmailTemplateSchema.index({ clientId: 1, legacyLocalId: 1 }, { sparse: true });

module.exports = mongoose.model('EmailTemplate', EmailTemplateSchema);
