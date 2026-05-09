"use strict";

const mongoose = require("mongoose");

const CheckoutLinkSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    shortCode: { type: String, required: true, unique: true },
    fullUrl: { type: String, required: true },
    phone: { type: String, default: "" },
    productItems: [
      {
        variantId: { type: String, default: "" },
        quantity: { type: Number, default: 1 },
        price: { type: Number, default: 0 }
      }
    ],
    totalValue: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    source: {
      type: String,
      enum: ["whatsapp_cart", "bot_recommendation", "campaign", "agent"],
      default: "whatsapp_cart"
    },
    sent: { type: Boolean, default: true },
    clicked: { type: Boolean, default: false },
    clickedAt: { type: Date },
    converted: { type: Boolean, default: false },
    convertedAt: { type: Date },
    shopifyOrderId: { type: String, default: "" },
    cartRecoverySent: { type: Boolean, default: false },
    cartRecoverySentAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

CheckoutLinkSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 }); // 7 days TTL

module.exports = mongoose.model("CheckoutLink", CheckoutLinkSchema);
