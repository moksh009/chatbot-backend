const mongoose = require('mongoose');

const qrCodeSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
    index: true
  },
  name:      { type: String, required: true, trim: true },
  shortCode: { type: String, required: true, unique: true }, // e.g. "QR_A1B2C3D4"
  type:      { type: String, enum: ['flow', 'catalog', 'offer', 'contact_capture'], default: 'flow' },
  isActive:  { type: Boolean, default: true },

  config: {
    flowId:         { type: String, default: '' },
    sequenceId:     { type: String, default: '' },
    discountCode:   { type: String, default: '' },
    discountValue:  { type: Number, default: 0 },
    welcomeMessage: { type: String, default: '' },
    tags:           [{ type: String }],
    utmSource:      { type: String, default: '' }
  },

  // Generated WhatsApp deep link
  waLink:      { type: String, default: '' },
  qrImageUrl:  { type: String, default: '' }, // base64 PNG data URL

  // Analytics
  scansTotal:  { type: Number, default: 0 },
  scansUnique: { type: Number, default: 0 },
  conversions: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null }
});

qrCodeSchema.index({ clientId: 1 });
qrCodeSchema.index({ shortCode: 1 }, { unique: true });

module.exports = mongoose.model('QRCode', qrCodeSchema);
