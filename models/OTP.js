const mongoose = require('mongoose');

const OTPSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
  },
  otp: {
    type: String,
    required: true,
  },
  purpose: {
    type: String, // 'SIGNUP' or 'RESET_PASSWORD'
    enum: ['SIGNUP', 'RESET_PASSWORD'],
    required: true,
    default: 'SIGNUP'
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 300 // TTL index: Automatically deletes document after 5 minutes (300 seconds)
  }
});

module.exports = mongoose.model('OTP', OTPSchema);
