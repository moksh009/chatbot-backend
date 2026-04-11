const mongoose = require('mongoose');

const unrecognizedPhraseSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  phrase: {
    type: String,
    required: true
  },
  language: {
    type: String,
    default: 'unknown'
  },
  phoneNumber: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['PENDING', 'RESOLVED', 'IGNORED'],
    default: 'PENDING'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('UnrecognizedPhrase', unrecognizedPhraseSchema);
