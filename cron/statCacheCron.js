const cron = require('node-cron');
const Client = require('../models/Client');
const { rebuildCache, dailyReset } = require('../utils/statCacheEngine');
const {
  rollupYesterdayForAllClients,
  rollupTodayForAllClients,
} = require('../utils/dailyStatRollup');
const log = require('../utils/logger')('StatCacheCron');
const { wrapCron } = require('../utils/perfLogger');

/**
 * StatCache Cron Jobs
 * 
 * 1. Daily Reset (12:00 AM IST) — Zero out today counters for all clients
 * 2. Daily Reconciliation (12:05 AM IST) — Full rebuild to correct drift
 */
const scheduleStatCacheCron = () => {
  // 1. Daily Reset at IST midnight (UTC 18:30 previous day)
  cron.schedule('30 18 * * *', wrapCron('StatCache daily reset', async () => {
    log.info('[StatCacheCron] Running daily counter reset...');
    const clients = await Client.find({ isActive: { $ne: false } }).select('clientId').lean();
    for (const c of clients) {
      await dailyReset(c.clientId);
    }
    log.info(`[StatCacheCron] Daily reset completed for ${clients.length} clients`);
  }));

  // 2. Daily Reconciliation at IST 12:05 AM (UTC 18:35 previous day)
  cron.schedule('35 18 * * *', wrapCron('StatCache daily reconciliation', async () => {
    log.info('[StatCacheCron] Running daily reconciliation rebuild...');
    const clients = await Client.find({ isActive: { $ne: false } }).select('clientId').lean();
    for (const c of clients) {
      await rebuildCache(c.clientId);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    log.info(`[StatCacheCron] Reconciliation completed for ${clients.length} clients`);
  }));

  // 3. DailyStat rollup for yesterday (IST 12:15 AM = UTC 18:45 previous day) — after stat cache reset
  cron.schedule('45 18 * * *', wrapCron('DailyStat rollup yesterday', async () => {
    log.info('[StatCacheCron] Running DailyStat rollup for yesterday...');
    await rollupYesterdayForAllClients();
  }));

  // 4. Refresh today's DailyStat rollup every hour at :25
  cron.schedule('25 * * * *', wrapCron('DailyStat rollup today', async () => {
    if (process.env.DAILY_STAT_ROLLUP_HOURLY === 'false') return;
    log.info('[StatCacheCron] Running hourly DailyStat rollup for today...');
    await rollupTodayForAllClients();
  }));
};

module.exports = scheduleStatCacheCron;
