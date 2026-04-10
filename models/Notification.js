const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, enum: ['lead', 'sentiment', 'campaign', 'system', 'assignment'], default: 'system' },
  status: { type: String, enum: ['unread', 'read'], default: 'unread' },
  metadata: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Notification', notificationSchema);
