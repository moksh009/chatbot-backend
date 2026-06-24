const mongoose = require('mongoose');

const PixelEventSchema = new mongoose.Schema({
    clientId: { type: String, required: true, index: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', default: null },
    sessionId: { type: String, index: true }, // From cookie/localstorage
    eventName: {
        type: String,
        enum: [
            'page_view',
            'product_view',
            'add_to_cart',
            'product_added_to_cart',
            'checkout_started',
            'checkout_completed',
            'checkout_contact_identified',
            'checkout_contact_info_submitted',
            'contact',
            'contact_identified',
            'search',
            'exit_intent',
        ],
        required: true
    },
    url: String,
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    userAgent: String,
    ip: String,
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

// Index for funnel analytics
PixelEventSchema.index({ clientId: 1, eventName: 1, timestamp: -1 });

// Automatic cleanup: delete raw pixel events after 180 days
PixelEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('PixelEvent', PixelEventSchema);
