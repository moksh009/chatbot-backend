const mongoose = require("mongoose");

const ReviewRequestSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  phone: { type: String, required: true },
  orderId: { type: String },
  orderNumber: String,
  productName: String,
  reviewUrl: String,
  status: { 
    type: String, 
    enum: ["scheduled","sent","responded_positive","responded_negative","skipped"],
    default: "scheduled"
  },
  scheduledFor: { type: Date, required: true },
  sentAt: Date,
  response: String
}, { timestamps: true });

module.exports = mongoose.model("ReviewRequest", ReviewRequestSchema);
