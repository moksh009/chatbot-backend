"use strict";

const mongoose = require("mongoose");

/**
 * Optional persisted security audit trail (enable with SECURITY_AUDIT_PERSIST=true).
 * TTL index auto-purges after 90 days.
 */
const SecurityAuditLogSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, index: true },
    ip: String,
    path: String,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    tenantId: { type: String, index: true },
    targetClientId: { type: String, index: true },
    reason: String,
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

SecurityAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model("SecurityAuditLog", SecurityAuditLogSchema);
