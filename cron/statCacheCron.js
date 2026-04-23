const cron = require('node-cron');
const Client = require('../models/Client');
const { rebuildCache, dailyReset } = require('../utils/statCacheEngine');
const log = require('../utils/logger')('StatCacheCron');

/**
 * StatCache Cron Jobs
 * 
 * 1. Daily Reset (12:00 AM IST) — Zero out today counters for all clients
 * 2. Daily Reconciliation (12:05 AM IST) — Full rebuild to correct drift
 */
const scheduleStatCacheCron = () => {
  // 1. Daily Reset at IST midnight (UTC 18:30 previous day)
  cron.schedule('30 18 * * *', async () => {
    log.info('[StatCacheCron] Running daily counter reset...');
    try {
      const clients = await Client.find({ isActive: { $ne: false } }).select('clientId').lean();
      for (const c of clients) {
        await dailyReset(c.clientId);
      }
      log.info(`[StatCacheCron] Daily reset completed for ${clients.length} clients`);
    } catch (err) {
      log.error('[StatCacheCron] Daily reset failed:', err.message);
    }
  });

  // 2. Daily Reconciliation at IST 12:05 AM (UTC 18:35 previous day)
  cron.schedule('35 18 * * *', async () => {
    log.info('[StatCacheCron] Running daily reconciliation rebuild...');
    try {
      const clients = await Client.find({ isActive: { $ne: false } }).select('clientId').lean();
      for (const c of clients) {
        await rebuildCache(c.clientId);
        // Stagger to avoid thundering herd
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      log.info(`[StatCacheCron] Reconciliation completed for ${clients.length} clients`);
    } catch (err) {
      log.error('[StatCacheCron] Reconciliation failed:', err.message);
    }
  });
};

module.exports = scheduleStatCacheCron;
