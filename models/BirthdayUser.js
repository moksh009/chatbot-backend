// models/BirthdayUser.js
const mongoose = require('mongoose');

const birthdayUserSchema = new mongoose.Schema({
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  number: { type: String, required: true },
  month: { type: Number, required: true },
  day: { type: Number, required: true },
  isOpted: { type: Boolean, default: true },
  optedOutOn: { type: String, default: '' }
});

module.exports = mongoose.model('BirthdayUser', birthdayUserSchema);
