const mongoose = require('mongoose');

const optInSavedTemplateSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  type: {
    type: String,
    enum: ['whatsapp_widget', 'popup', 'spin_wheel', 'mystery_discount'],
    required: true,
  },
  design: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  triggers: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  prizes: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
  mysteryRevealType: { type: String, default: 'scratch' },
  previewColor: { type: String, default: '#7C3AED' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

optInSavedTemplateSchema.index({ clientId: 1, type: 1 });

optInSavedTemplateSchema.pre('save', function preSave(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('OptInSavedTemplate', optInSavedTemplateSchema);
