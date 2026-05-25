"use strict";

const mongoose = require("mongoose");

const TemplateSendLogSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "MetaTemplate", default: null },
    templateName: { type: String, default: "" },
    automationSlotId: { type: String, default: null, index: true },
    contextType: { type: String, default: null },
    failureCode: {
      type: String,
      enum: [
        "sent",
        "skipped",
        "missing_template",
        "not_approved",
        "no_mapping",
        "missing_recipient",
        "client_not_found",
        "send_error",
        "prebuilt_not_approved",
        null,
      ],
      default: null,
    },
    channel: { type: String, enum: ["whatsapp", "email", "both"], default: "whatsapp" },
    recipientPhone: { type: String, default: "" },
    recipientEmail: { type: String, default: "" },
    contextData: { type: mongoose.Schema.Types.Mixed, default: {} },
    resolvedVariables: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["sent", "delivered", "failed", "skipped"], default: "sent" },
    errorMessage: { type: String, default: null },
    sentAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

TemplateSendLogSchema.index({ sentAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
TemplateSendLogSchema.index({ clientId: 1, failureCode: 1, sentAt: -1 });

module.exports = mongoose.model("TemplateSendLog", TemplateSendLogSchema);
