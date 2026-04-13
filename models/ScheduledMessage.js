const mongoose = require('mongoose');

const ScheduledMessageSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    required: true
  },
  channel: {
    type: String,
    enum: ['whatsapp', 'instagram'],
    required: true
  },
  messageType: {
    type: String,
    enum: ['text', 'interactive', 'template', 'image'],
    default: 'text'
  },
  content: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  sendAt: {
    type: Date,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'sent', 'cancelled', 'failed'],
    default: 'pending',
    index: true
  },
  sourceType: {
    type: String,
    enum: ['follow_up', 'cart_recovery', 'review', 'delay_node'],
    required: true
  },
  sourceId: {
    type: String,
    required: true
  },
  cancelIf: {
    type: mongoose.Schema.Types.Mixed, // e.g. { linkClicked: true }
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for the cron job to quickly find pending messages
ScheduledMessageSchema.index({ sendAt: 1, status: 1 });

module.exports = mongoose.model('ScheduledMessage', ScheduledMessageSchema);
