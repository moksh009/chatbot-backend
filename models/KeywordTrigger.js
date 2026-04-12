const mongoose = require("mongoose");

const KeywordTriggerSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  keyword: { type: String, required: true },
  type: { type: String, enum: ['exact', 'fuzzy'], default: 'exact' },
  actionType: { type: String, enum: ['trigger_flow', 'send_template', 'add_tag'], required: true },
  targetId: { type: String, required: true }, // The flow ID, template ID, or tag name
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model("KeywordTrigger", KeywordTriggerSchema);
