const mongoose = require('mongoose');

const FollowUpSequenceSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead' },
  phone: { type: String, required: true },
  status: { type: String, enum: ["active","completed","cancelled"], default: "active" },
  steps: [{
    message: String,
    templateId: String,
    sendAt: Date,
    status: { type: String, enum: ["pending","sent","failed"], default: "pending" },
    sentAt: Date
  }]
}, { timestamps: true });

module.exports = mongoose.model('FollowUpSequence', FollowUpSequenceSchema);
