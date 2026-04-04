const mongoose = require('mongoose');

const ExportJobSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['conversations_pdf', 'conversations_json', 'conversations_csv'],
    default: 'conversations_pdf'
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  progress: {
    type: Number,
    default: 0
  },
  totalItems: {
    type: Number,
    default: 0
  },
  processedItems: {
    type: Number,
    default: 0
  },
  fileUrl: {
    type: String
  },
  fileName: {
    type: String
  },
  error: {
    type: String
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 } // TTL index for automatic cleanup
  }
}, { timestamps: true });

module.exports = mongoose.model('ExportJob', ExportJobSchema);
