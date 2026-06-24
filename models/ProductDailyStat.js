const mongoose = require('mongoose');

const ProductDailyStatSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    productId: { type: String, required: true },
    handle: { type: String, default: '' },
    title: { type: String, default: '' },
    image: { type: String, default: '' },
    views: { type: Number, default: 0 },
    addToCarts: { type: Number, default: 0 },
    checkoutsStarted: { type: Number, default: 0 },
    purchases: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ProductDailyStatSchema.index({ clientId: 1, date: 1, productId: 1 }, { unique: true });
ProductDailyStatSchema.index({ clientId: 1, date: -1 });

module.exports = mongoose.model('ProductDailyStat', ProductDailyStatSchema);
