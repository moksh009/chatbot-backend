const mongoose = require('mongoose');

const SupplierProductSchema = new mongoose.Schema({
  productId:     { type: String, required: true },
  productTitle:  { type: String },
  supplierSKU:   { type: String },
  unitCost:      { type: Number },
  moq:           { type: Number, default: 1 },       // minimum order quantity
  leadTimeDays:  { type: Number },
  lastOrderedAt: { type: Date }
}, { _id: false });

const SupplierSchema = new mongoose.Schema({
  clientId:    { type: String, required: true },
  name:        { type: String, required: true },           // "TechParts Wholesale"
  phone:       { type: String, required: true },           // WhatsApp number of supplier
  email:       { type: String },
  category:    { type: String },           // "electronics" | "packaging" | "logistics"
  
  products:    [SupplierProductSchema],
  
  isPreferred: { type: Boolean, default: false },
  notes:       { type: String },
  
  // Communication stats
  avgResponseTimeHours: { type: Number },
  totalOrders:          { type: Number, default: 0 },
  
  createdAt:   { type: Date, default: Date.now }
});

SupplierSchema.index({ clientId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('Supplier', SupplierSchema);
