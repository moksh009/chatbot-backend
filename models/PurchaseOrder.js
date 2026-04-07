const mongoose = require('mongoose');

const PurchaseOrderSchema = new mongoose.Schema({
  clientId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  supplierId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  items: [{
    productId:    { type: String, required: true },
    productTitle: { type: String },
    quantity:     { type: Number, required: true },
    unitCost:     { type: Number }
  }],
  totalCost:    { type: Number },
  status:       { type: String, enum: ["sent", "confirmed", "delivered", "cancelled"], default: "sent" },
  sentAt:       { type: Date, default: Date.now },
  confirmedAt:  { type: Date },
  deliveredAt:  { type: Date },
  notes:        { type: String }
});

module.exports = mongoose.model('PurchaseOrder', PurchaseOrderSchema);
