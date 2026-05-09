const mongoose = require('mongoose');

const FollowUpSequenceSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead' },
  phone: { type: String },
  email: { type: String },
  name: { type: String, default: 'Untitled Sequence' },
  type: { type: String, enum: ["custom", "loyalty_reminder", "review_request", "abandoned_cart", "warranty_resend", "warranty_certificate"], default: "custom" },
  status: { type: String, enum: ["active", "completed", "cancelled", "paused"], default: "active" },
  steps: [{
    type: { type: String, enum: ['whatsapp', 'email'], default: 'whatsapp' },
    templateId: String, // For Meta WhatsApp Templates
    templateName: String,
    subject: String, // For Email
    content: String, // For Email or Custom Text
    delayValue: Number, // Value (e.g. 15)
    delayUnit: { type: String, enum: ['m', 'h', 'd'], default: 'm' },
    sendAt: Date,
    status: { type: String, enum: ["pending", "sent", "failed", "skipped"], default: "pending" },
    sentAt: Date,
    errorLog: String,
    condition: String,
    mediaType: { type: String, enum: ['none', 'static', 'dynamic'], default: 'none' },
    mediaUrl: String
  }]
}, { timestamps: true });

FollowUpSequenceSchema.index({ status: 1, "steps.sendAt": 1 });
FollowUpSequenceSchema.index({ clientId: 1, status: 1 });
/** Active sequences per lead — speeds enrollment checks + cron */
FollowUpSequenceSchema.index({ clientId: 1, leadId: 1, status: 1 });

module.exports = mongoose.model('FollowUpSequence', FollowUpSequenceSchema);
