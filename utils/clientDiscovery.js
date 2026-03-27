const Client = require('../models/Client');

/**
 * Finds a client based on the WhatsApp Phone Number ID from the Meta payload.
 * This is crucial for a unified root webhook.
 */
async function discoverClientByPhoneId(phoneNumberId) {
    if (!phoneNumberId) return null;
    try {
        // Search for client by specifically configured phoneNumberId
        let client = await Client.findOne({ phoneNumberId });
        
        if (!client) {
            // Fallback: check nested config if they used the older format
            client = await Client.findOne({ 'config.phoneNumberId': phoneNumberId });
        }
        
        return client;
    } catch (err) {
        console.error('[ClientDiscovery] Error finding client:', err.message);
        return null;
    }
}

module.exports = { discoverClientByPhoneId };
