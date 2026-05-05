const mongoose = require('mongoose');

const GrowthQrScanSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  source: { type: String, default: 'qr', index: true },
  ipAddress: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  scannedAt: { type: Date, default: Date.now, index: true },
});

GrowthQrScanSchema.index({ clientId: 1, source: 1, scannedAt: -1 });

module.exports = mongoose.model('GrowthQrScan', GrowthQrScanSchema);
