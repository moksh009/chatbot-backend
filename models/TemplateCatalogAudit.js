"use strict";

const mongoose = require("mongoose");

const GapSchema = new mongoose.Schema(
  {
    slotId: { type: String, required: true },
    title: { type: String, default: "" },
    status: { type: String, default: "MISSING" },
    activeMetaName: { type: String, default: null },
    isMissing: { type: Boolean, default: true },
    isApproved: { type: Boolean, default: false },
  },
  { _id: false }
);

const TemplateCatalogAuditSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    businessName: { type: String, default: "" },
    catalogVersion: { type: Number, default: 1 },
    auditedAt: { type: Date, default: Date.now, index: true },
    totalSlots: { type: Number, default: 0 },
    approvedCount: { type: Number, default: 0 },
    missingCount: { type: Number, default: 0 },
    pendingCount: { type: Number, default: 0 },
    needsAction: { type: Boolean, default: false, index: true },
    gaps: { type: [GapSchema], default: [] },
    wabaConnected: { type: Boolean, default: false },
    multiStoreModel: {
      type: String,
      default: "one_client_one_waba",
    },
  },
  { timestamps: false }
);

TemplateCatalogAuditSchema.index({ clientId: 1, auditedAt: -1 });
TemplateCatalogAuditSchema.index({ needsAction: 1, auditedAt: -1 });

module.exports = mongoose.model("TemplateCatalogAudit", TemplateCatalogAuditSchema);
