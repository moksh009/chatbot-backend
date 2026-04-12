const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  type: { 
    type: String, 
    required: true, 
    enum: ['ORDER', 'LEAD', 'TASK', 'MESSAGE', 'CAMPAIGN', 'SYSTEM', 'INTEGRATION'],
    index: true 
  },
  status: { 
    type: String, 
    enum: ['success', 'warning', 'error', 'info'], 
    default: 'info' 
  },
  title: { type: String, required: true },
  message: { type: String },
  icon: { type: String }, // Lucide icon name string
  url: { type: String }, // Link to take action (e.g., /live-chat?phone=...)
  metadata: { type: mongoose.Schema.Types.Mixed }, // Dynamic data like order values, task IDs
  createdAt: { type: Date, default: Date.now, expires: '30d' } // 30-day TTL as requested
});

// Index for efficient fetching by client and date
activityLogSchema.index({ clientId: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
