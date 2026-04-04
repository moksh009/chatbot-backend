const mongoose = require('mongoose');

const qrScanSchema = new mongoose.Schema({
  qrCodeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'QRCode', required: true },
  phone:     { type: String, required: true },
  scannedAt: { type: Date, default: Date.now }
});

qrScanSchema.index({ qrCodeId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('QRScan', qrScanSchema);
