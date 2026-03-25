const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  clientId: { type: String, required: true }, // e.g., 'delitech_smarthomes'
  shopifyOrderId: { type: String }, // e.g., '529348239048'
  orderId: { type: String, required: true, unique: true }, // e.g., #1001
  orderNumber: { type: String }, 
  customerName: { type: String, required: true },
  phone: { type: String },
  email: { type: String },
  amount: { type: Number, required: true },
  totalPrice: { type: Number },
  status: { type: String, default: 'pending' }, // pending, paid, shipped, confirmed
  paymentMethod: { type: String }, // e.g., 'Cash on Delivery (COD)'
  isCOD: { type: Boolean, default: false },
  razorpayLinkId: { type: String },
  razorpayUrl: { type: String },
  cashfreeLinkId: { type: String },
  cashfreeUrl: { type: String },
  paidViaLink: { type: Boolean, default: false },
  paidAt: { type: Date },
  codNudgeSentAt: { type: Date },
  source: { type: String },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  zip: { type: String },
  items: [{
    name: String,
    quantity: Number,
    price: Number,
    sku: String
  }],
  shippingAddress: { type: Object },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Order', OrderSchema);