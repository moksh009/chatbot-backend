const DailyStat = require('../models/DailyStat');

/**
 * Increments daily statistics for a given client.
 * @param {string} clientId - The client's ID.
 * @param {object} increments - Dictionary of fields to increment.
 * @param {object} productAdditions - Optional { productName: count } to add to abandonedProducts map.
 */
async function trackEcommerceEvent(clientId, increments = {}, productAdditions = {}) {
    const today = new Date().toISOString().split('T')[0];
    
    try {
        const update = { $inc: increments };
        
        // Handle Map increments for abandonedProducts
        if (Object.keys(productAdditions).length > 0) {
            for (const [name, count] of Object.entries(productAdditions)) {
                // MongoDB Map increment syntax: abandonedProducts.key
                update.$inc[`abandonedProducts.${name}`] = count;
            }
        }

        await DailyStat.findOneAndUpdate(
            { clientId, date: today },
            update,
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (err) {
        console.error(`[AnalyticsHelper] Failed to track event for ${clientId}:`, err.message);
    }
}

module.exports = { trackEcommerceEvent };
