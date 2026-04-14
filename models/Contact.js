const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  phoneNumber: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  lastPurchaseDate: {
    type: Date
  },
  meta: {
    type: Object,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Ensure uniqueness per client
contactSchema.index({ clientId: 1, phoneNumber: 1 }, { unique: true });

const Contact = mongoose.model('Contact', contactSchema);

module.exports = Contact;
