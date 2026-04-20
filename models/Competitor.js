const mongoose = require('mongoose');

const CompetitorProductSchema = new mongoose.Schema({
  id:             { type: String, required: true },
  title:          { type: String, required: true },
  url:            { type: String, required: true },   // their product page URL
  ourProductId:   { type: String },                   // which of OUR products competes
  lastKnownPrice: { type: Number },
  lastCheckedAt:  { type: Date },
  priceHistory: [{
    price:     { type: Number },
    checkedAt: { type: Date, default: Date.now }
  }]
}, { _id: false });

const CompetitorSchema = new mongoose.Schema({
  clientId:      { type: String, required: true },
  name:          { type: String, required: true },     // "BrightHome Doorbells"
  website:       { type: String },
  whatsappPhone: { type: String },
  
  products:      [CompetitorProductSchema],
  
  isActive:      { type: Boolean, default: true },
  trackingPreferences: { type: [String], default: [] },
  priceIndex:    { type: String },
  catalogSize:   { type: String },
  activityScore: { type: String },
  pricePosition: { type: String, enum: ['lower', 'higher', 'equal'] },
  status:        { type: String, enum: ['analyzing', 'monitored', 'error'], default: 'monitored' },
  battlePlan:    { type: [String], default: [] },
  notes:         { type: String },
  createdAt:     { type: Date, default: Date.now },
  lastBattlePlanGeneratedAt: { type: Date }
});

CompetitorSchema.index({ clientId: 1, isActive: 1 });

module.exports = mongoose.model('Competitor', CompetitorSchema);
