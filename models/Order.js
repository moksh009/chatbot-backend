const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  clientId: { type: String, required: true }, // e.g., 'delitech_smarthomes'
  orderId: { type: String, required: true, unique: true }, // e.g., #1001
  customerName: { type: String, required: true },
  phone: { type: String },
  amount: { type: Number, required: true },
  status: { type: String, default: 'pending' }, // pending, paid, shipped
  items: [{
    name: String,
    quantity: Number,
    price: Number
  }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Order', OrderSchema);