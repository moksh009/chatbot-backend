const Client = require('../models/Client');

/**
 * Finds a client based on the WhatsApp Phone Number ID from the Meta payload.
 * This is crucial for a unified root webhook.
 */
async function discoverClientByPhoneId(phoneNumberId) {
    if (!phoneNumberId) return null;
    try {
        // 1. Primary configured phoneNumberId
        let client = await Client.findOne({ phoneNumberId });
        
        if (!client) {
            // 2. Multi-WABA linked accounts
            client = await Client.findOne({ 'wabaAccounts.phoneNumberId': phoneNumberId });
        }
        
        if (!client) {
            // 3. Fallback: check nested config
            client = await Client.findOne({ 'config.phoneNumberId': phoneNumberId });
        }
        return client;
    } catch (err) {
        console.error('[ClientDiscovery] Error finding client:', err.message);
        return null;
    }
}

module.exports = { discoverClientByPhoneId };
