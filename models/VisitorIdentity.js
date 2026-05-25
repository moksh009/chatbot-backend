const mongoose = require("mongoose");

const visitorIdentitySchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    visitorId: { type: String, default: "", index: true },
    shopifyClientId: { type: String, default: "", index: true },
    checkoutTokens: { type: [String], default: [] },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "AdLead", default: null },
    phone: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true, trim: true },
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

visitorIdentitySchema.index({ clientId: 1, visitorId: 1 });
visitorIdentitySchema.index({ clientId: 1, shopifyClientId: 1 });
visitorIdentitySchema.index({ clientId: 1, phone: 1 });
visitorIdentitySchema.index({ clientId: 1, checkoutTokens: 1 });
visitorIdentitySchema.index({ lastSeen: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model("VisitorIdentity", visitorIdentitySchema);
