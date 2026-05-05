const mongoose = require('mongoose');

const importSessionSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  batchId: {
    type: String,
    required: true,
    index: true,
    unique: true
  },
  filename: String,
  batchName: String,
  newPhones: [String],
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'rolled_back'],
    default: 'pending'
  },
  totalRows: { type: Number, default: 0 },
  processedRows: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
  duplicateCount: { type: Number, default: 0 },
  errorLog: {
    type: [{
      row: Number,
      error: String,
      reason: String,
      phone: String,
      data: mongoose.Schema.Types.Mixed
    }],
    default: () => []
  },
  importConsentType: { type: String, default: 'unknown' },
  consentAcknowledged: { type: Boolean, default: false },
  consentDeclaredBy: { type: String, default: '' },
  consentDeclaredAt: { type: Date },
  createdAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    default: () => new Date(+new Date() + 24*60*60*1000) // 24h rollback window
  }
});

module.exports = mongoose.model('ImportSession', importSessionSchema);
