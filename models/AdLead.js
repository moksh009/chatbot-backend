const mongoose = require('mongoose');

const adLeadSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const AdLead = mongoose.model('AdLead', adLeadSchema);

module.exports = AdLead;
