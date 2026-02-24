const mongoose = require("mongoose");

const AppointmentSchema = new mongoose.Schema({
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  name: { type: String, required: true },
  email: { type: String },
  phone: { type: String, required: true },
  service: { type: String, required: true },
  doctor: { type: String, required: true },
  date: { type: String, required: true }, // e.g., 'Tuesday, 23 Jul'
  time: { type: String, required: true }, // e.g., '11:00 AM'
  eventId: { type: String }, // Google Calendar event ID
  bookingSource: {
    type: String,
    enum: ['chatbot', 'manual'],
    default: 'chatbot'
  },
  status: {
    type: String,
    enum: ['confirmed', 'cancelled', 'completed'],
    default: 'confirmed'
  },
  cancelledAt: { type: Date },
  cancelledBy: { type: String }, // User ID or 'chatbot'
  logs: [{
    action: String, // 'create', 'update', 'cancel'
    changedBy: String,
    changedAt: { type: Date, default: Date.now },
    source: String, // 'dashboard', 'chatbot'
    details: String
  }],
  consent: {
    appointmentReminders: { type: Boolean, default: true },
    birthdayMessages: { type: Boolean, default: true },
    marketingMessages: { type: Boolean, default: true },
    consentedAt: { type: Date, default: Date.now }
  },
  revenue: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update the updatedAt field before saving
AppointmentSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Concurrency is now managed in application logic (Capacity: 4 per slot)
// AppointmentSchema.index({ clientId: 1, doctor: 1, date: 1, time: 1 }, { unique: true });

module.exports = mongoose.model('Appointment', AppointmentSchema); 
