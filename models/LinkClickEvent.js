const mongoose = require('mongoose');

const LinkClickEventSchema = new mongoose.Schema({
    clientId: { type: String, required: true, index: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', default: null },
    productId: { type: String },
    url: { type: String },
    timestamp: { type: Date, default: Date.now }
});

// Compound index for timeline aggregation
LinkClickEventSchema.index({ clientId: 1, timestamp: 1 });

module.exports = mongoose.model('LinkClickEvent', LinkClickEventSchema);
