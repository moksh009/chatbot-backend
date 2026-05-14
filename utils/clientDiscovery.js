const Client = require('../models/Client');
const { phoneNumberIdMatchFilter } = require('./clientWhatsAppCreds');

/**
 * Finds a client based on the WhatsApp Phone Number ID from the Meta payload.
 * This is crucial for a unified root webhook.
 */
async function discoverClientByPhoneId(phoneNumberId) {
    if (!phoneNumberId) return null;
    try {
        const filter = phoneNumberIdMatchFilter(phoneNumberId);
        if (!filter) return null;
        return await Client.findOne(filter);
    } catch (err) {
        console.error('[ClientDiscovery] Error finding client:', err.message);
        return null;
    }
}

module.exports = { discoverClientByPhoneId };
