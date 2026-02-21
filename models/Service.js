const mongoose = require("mongoose");

const ServiceSchema = new mongoose.Schema({
    clientId: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, default: 0 },
    duration: { type: Number }, // Duration in minutes
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

ServiceSchema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});

module.exports = mongoose.model('Service', ServiceSchema);
