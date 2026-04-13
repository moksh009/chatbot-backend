const mongoose = require('mongoose');

const metaAdSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true
  },

  // From Meta API
  metaAdId:         { type: String, required: true },
  metaCampaignId:   { type: String, default: '' },
  metaCampaignName: { type: String, default: '' },
  adName:           { type: String, default: '' },
  adStatus:         { type: String, default: 'ACTIVE' }, // ACTIVE | PAUSED | ARCHIVED
  creativeTitle:    { type: String, default: '' },
  creativeBody:     { type: String, default: '' },
  creativeImageUrl: { type: String, default: '' },
  callToAction:     { type: String, default: '' },
  createdTime:      { type: Date },

  // TopEdge configuration
  attachedFlowId:       { type: String, default: '' },
  attachedSequenceId:   { type: String, default: '' },
  customWelcomeMessage: { type: String, default: '' },
  utmLabel:             { type: String, default: '' },

  // Synced from Meta (daily cron)
  insights: {
    impressions:  { type: Number, default: 0 },
    clicks:       { type: Number, default: 0 },
    spend:        { type: Number, default: 0 },
    cpc:          { type: Number, default: 0 },
    ctr:          { type: Number, default: 0 },
    reach:        { type: Number, default: 0 },
    lastSyncedAt: { type: Date }
  },

  // Calculated from TopEdge data
  topedgeStats: {
    leadsCount:     { type: Number, default: 0 },
    ordersCount:    { type: Number, default: 0 },
    revenue:        { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 },
    costPerLead:    { type: Number, default: 0 },
    roiPercent:     { type: Number, default: 0 }
  },

  lastImportedAt: { type: Date },
  createdAt:      { type: Date, default: Date.now }
});

metaAdSchema.index({ clientId: 1, metaAdId: 1 }, { unique: true });
metaAdSchema.index({ clientId: 1, adStatus: 1 });

module.exports = mongoose.model('MetaAd', metaAdSchema);
