const mongoose = require("mongoose");

const ProviderSchema = new mongoose.Schema({
    clientId: { type: String, required: true },
    name: { type: String, required: true },
    role: { type: String, default: 'Staff' }, // e.g., Doctor, Stylist, Coach
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

ProviderSchema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});

module.exports = mongoose.model('Provider', ProviderSchema);
