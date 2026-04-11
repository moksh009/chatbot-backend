const Client = require('../models/Client');
const NlpEngineService = require('./NlpEngineService');

/**
 * Primes the NLP engine on server startup.
 * Loads all active client models into memory to ensure zero-lag initial responses.
 */
async function bootIntentEngine() {
  try {
    console.log('[NLP_BOOT] Starting NLP engine initialization...');
    
    // Find all clients that have at least one intent rule defined
    // Or just all active clients
    const clients = await Client.find({ isActive: true }).select('clientId');
    
    let successCount = 0;
    for (const client of clients) {
      try {
        await NlpEngineService.trainClientModel(client.clientId);
        successCount++;
      } catch (err) {
        console.error(`[NLP_BOOT] Failed to prime engine for client ${client.clientId}:`, err.message);
      }
    }
    
    console.log(`[NLP_BOOT] NLP Engine primed for ${successCount}/${clients.length} active clients.`);
  } catch (error) {
    console.error('[NLP_BOOT] Critical error during boot sequence:', error);
  }
}

module.exports = { bootIntentEngine };
