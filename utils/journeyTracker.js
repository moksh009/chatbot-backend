const AdLead = require('../models/AdLead');
const log = require('./logger')('JourneyTracker');

/**
 * Standardized Journey Event Logger
 * Normalizes e-commerce, AI, and marketing events into the lead's timeline.
 */
async function trackEvent(clientId, phone, eventType, details = {}, options = {}) {
    try {
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId });
        if (!lead) return;

        // Unified payload mapping
        const mappedData = {
            action: eventType,
            details: typeof details === 'string' ? details : JSON.stringify(details),
            timestamp: new Date()
        };

        const updateSet = {
            $push: { activityLog: mappedData }
        };

        // Specific Lifecycle Triggers
        const tagsToAdd = [];
        if (eventType === 'order_placed') {
            updateSet.$set = { status: 'purchased', cartStatus: 'purchased' };
            tagsToAdd.push('converted');
        } else if (eventType === 'cart_abandoned') {
            updateSet.$set = { cartStatus: 'active' };
            tagsToAdd.push('abandoned_cart');
        } else if (eventType === 'warranty_registered') {
            tagsToAdd.push('warranty_holder');
        } else if (eventType === 'negative_review') {
            tagsToAdd.push('at_risk');
        }

        if (tagsToAdd.length > 0) {
            updateSet.$addToSet = { tags: { $each: tagsToAdd } };
        }

        await AdLead.findByIdAndUpdate(lead._id, updateSet);
        
        // Also fire off to the new Journey log structure for pure chronological views
        await AdLead.pushJourneyEvent(clientId, phone, eventType, details);

    } catch (err) {
        log.error(`Failed to track journey event ${eventType} for ${phone}:`, err.message);
    }
}

module.exports = {
    trackEvent
};
