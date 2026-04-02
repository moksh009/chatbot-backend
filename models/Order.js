const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  shopifyOrderId: { type: String },
  orderId: { type: String, required: true },
  orderNumber: { type: String },
  customerName: { type: String },
  name: { type: String },              // Alias of customerName (Shopify compat)
  phone: { type: String },             // Legacy field
  customerPhone: { type: String },     // New standardized field
  email: { type: String },             // Legacy field
  customerEmail: { type: String },     // New standardized field for email automation
  amount: { type: Number },            // Legacy field (not required — totalPrice is used)
  totalPrice: { type: Number },
  status: { type: String, default: 'pending' },
  paymentMethod: { type: String },
  storeString: { type: String },
  isCOD: { type: Boolean, default: false },
  razorpayLinkId: { type: String },
  razorpayUrl: { type: String },
  cashfreeLinkId: { type: String },
  cashfreeUrl: { type: String },
  paidViaLink: { type: Boolean, default: false },
  paidAt: { type: Date },
  codNudgeSentAt: { type: Date },
  codNudgeScheduledAt: { type: Date }, 
  codNudgeStatus: { type: String, default: 'none' }, // none, scheduled, sent, failed
  source: { type: String },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  zip: { type: String },
  fulfilledAt: { type: Date },
  trackingUrl: { type: String },
  trackingNumber: { type: String },
  items: [{
    name: String,
    quantity: Number,
    price: Number,
    sku: String
  }],
  shippingAddress: { type: Object },
  createdAt: { type: Date, default: Date.now }
});

OrderSchema.index({ orderId: 1, clientId: 1 }, { unique: true });

module.exports = mongoose.model('Order', OrderSchema);