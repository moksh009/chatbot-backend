const mongoose = require('mongoose');

const DailyStatSchema = new mongoose.Schema({
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  date: { type: String, required: true }, // YYYY-MM-DD
  totalChats: { type: Number, default: 0 },
  uniqueUsers: { type: Number, default: 0 },
  appointmentsBooked: { type: Number, default: 0 },
  birthdayRemindersSent: { type: Number, default: 0 },
  appointmentRemindersSent: { type: Number, default: 0 },
  totalMessagesExchanged: { type: Number, default: 0 },
  agentRequests: { type: Number, default: 0 },
  linkClicks: { type: Number, default: 0 },
  abandonedCartSent: { type: Number, default: 0 },
  abandonedCartClicks: { type: Number, default: 0 }
});

// Ensure unique stats per client per day
DailyStatSchema.index({ clientId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyStat', DailyStatSchema);
