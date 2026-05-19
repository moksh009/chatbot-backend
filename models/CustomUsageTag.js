const mongoose = require('mongoose');

const CustomUsageTagSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 50 },
  createdAt: { type: Date, default: Date.now },
});

CustomUsageTagSchema.index({ clientId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('CustomUsageTag', CustomUsageTagSchema);
