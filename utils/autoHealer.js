const Client = require('../models/Client');
const NotificationService = require('./notificationService');
const log = require('./logger')('AutoHealer');

/**
 * Categorizes and processes a failure from the WhatsApp/Meta API.
 * Tracks health stats and triggers alerts if a threshold is reached.
 */
async function reportApiFailure(clientId, error) {
  try {
    const errorCode = error.response?.data?.error?.code || error.code;
    const errorMessage = error.response?.data?.error?.message || error.message;

    const client = await Client.findOne({ clientId });
    if (!client) return;

    // 1. Update Maintenance Pulse
    const update = {
      $set: { 
        'maintenancePulse.lastError': errorMessage,
        'maintenancePulse.lastErrorAt': new Date()
      },
      $inc: { 'maintenancePulse.errorCount24h': 1 }
    };

    // 2. Automated Diagnostic Logic
    let autoHealingAction = null;

    if (errorCode === 190 || errorMessage.includes('token')) {
      // OAuth Token Expired
      update.$set.healthStatus = 'offline';
      autoHealingAction = 'Please re-authenticate your WhatsApp account in Settings.';
    } else if (errorCode === 100 || errorMessage.includes('template')) {
      // Template Issue
      update.$set.healthStatus = 'degraded';
      autoHealingAction = 'One or more message templates are inactive or rejected.';
    } else if (errorCode === 131030) {
      // Payment required / Tier limit
      update.$set.healthStatus = 'degraded';
      autoHealingAction = 'Meta Tier limit reached or payment method failed.';
    }

    const updatedClient = await Client.findOneAndUpdate({ clientId }, update, { new: true });

    // 3. Trigger Alert if health drops
    if (updatedClient.healthStatus !== 'operational' && autoHealingAction) {
      await NotificationService.createNotification(clientId, {
        type: 'alert',
        title: `Service ${updatedClient.healthStatus.toUpperCase()} ⚠️`,
        message: `Issue: ${errorMessage}. Action: ${autoHealingAction}`,
        priority: 'high'
      });
      log.warn(`Auto-Healer flagged ${clientId} as ${updatedClient.healthStatus}: ${errorMessage}`);
    }

  } catch (err) {
    log.error('AutoHealer process failure:', err.message);
  }
}

/**
 * Resets error counts daily. 
 * (Called by a cron job)
 */
async function resetDailyErrorCounts() {
  await Client.updateMany({}, { $set: { 'maintenancePulse.errorCount24h': 0 } });
  log.info('Daily error counts reset.');
}

module.exports = { reportApiFailure, resetDailyErrorCounts };
