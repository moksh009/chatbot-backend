const StatCache = require('../../models/StatCache');
const AdLead = require('../../models/AdLead');
const Order = require('../../models/Order');
const Conversation = require('../../models/Conversation');
const Appointment = require('../../models/Appointment');
const DailyStat = require('../../models/DailyStat');
const { startOfDayForDateStrIST, todayDateStrIST } = require('./queryHelpers');
const log = require('./logger')('StatCache');

/**
 * Atomic increment on StatCache.
 * Creates the document if it doesn't exist (upsert).
 * 
 * @param {string} clientId
 * @param {object} increments - e.g. { totalLeads: 1, leadsToday: 1 }
 */
async function incrementStat(clientId, increments) {
  try {
    await StatCache.updateOne(
      { clientId },
      { $inc: increments },
      { upsert: true }
    );
  } catch (err) {
    log.error(`[incrementStat] Failed for ${clientId}:`, err.message);
  }
}

/**
 * Full rebuild of StatCache from source collections.
 * Used for initial seeding and daily reconciliation.
 * 
 * @param {string} clientId
 */
async function rebuildCache(clientId) {
  try {
    const { timeParallel, createTimer } = require('./perfLogger');
    const timer = createTimer('statCacheEngine.rebuildCache', clientId);
    timer.checkpoint('START');

    const today = startOfDayForDateStrIST(todayDateStrIST());
    const query = { clientId };

    const {
      totalLeads,
      leadsToday,
      totalOrders,
      totalUnitsSoldAgg,
      ordersToday,
      unitsSoldTodayAgg,
      orderRevenueTodayAgg,
      appointmentsToday,
      appointmentRevenueTodayAgg,
      linkClicksAgg,
      cartAddsAgg,
      checkoutsAgg,
      abandonedCarts,
      recoveredCarts,
      totalConversations,
      cartStatsAgg,
      recoveryPurchasedAgg,
      adminFollowupsPurchased,
      sentimentAgg,
    } = await timeParallel(
      timer,
      {
        totalLeads: () => AdLead.countDocuments(query),
        leadsToday: () => AdLead.countDocuments({ ...query, createdAt: { $gte: today } }),
        totalOrders: () => Order.countDocuments(query),
        totalUnitsSoldAgg: () =>
          Order.aggregate([
            { $match: query },
            { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
            { $group: { _id: null, total: { $sum: { $ifNull: ['$items.quantity', 0] } } } },
          ]),
        ordersToday: () => Order.countDocuments({ ...query, createdAt: { $gte: today } }),
        unitsSoldTodayAgg: () =>
          Order.aggregate([
            { $match: { ...query, createdAt: { $gte: today } } },
            { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
            { $group: { _id: null, total: { $sum: { $ifNull: ['$items.quantity', 0] } } } },
          ]),
        orderRevenueTodayAgg: () =>
          Order.aggregate([
            { $match: { ...query, createdAt: { $gte: today } } },
            { $group: { _id: null, total: { $sum: '$amount' } } },
          ]),
        appointmentsToday: () =>
          Appointment.countDocuments({ ...query, createdAt: { $gte: today } }),
        appointmentRevenueTodayAgg: () =>
          Appointment.aggregate([
            { $match: { ...query, createdAt: { $gte: today } } },
            { $group: { _id: null, total: { $sum: '$revenue' } } },
          ]),
        linkClicksAgg: () =>
          AdLead.aggregate([
            { $match: query },
            { $group: { _id: null, total: { $sum: '$linkClicks' } } },
          ]),
        cartAddsAgg: () =>
          AdLead.aggregate([
            { $match: query },
            { $group: { _id: null, total: { $sum: '$addToCartCount' } } },
          ]),
        checkoutsAgg: () =>
          AdLead.aggregate([
            { $match: query },
            { $group: { _id: null, total: { $sum: '$checkoutInitiatedCount' } } },
          ]),
        abandonedCarts: () => AdLead.countDocuments({ ...query, cartStatus: 'abandoned' }),
        recoveredCarts: async () => {
          const { calculateRecoveryMetrics } = require('../../services/cartRecoveryMetricsService');
          const { istDateRangeStrings } = require('./queryHelpers');
          const { start } = istDateRangeStrings(30);
          const from = startOfDayForDateStrIST(start);
          const metrics = await calculateRecoveryMetrics(clientId, {
            mode: 'cohort',
            from,
            to: new Date(),
            includeFunnel: false,
            includeRows: false,
          });
          return metrics.recoveredCarts;
        },
        totalConversations: () => Conversation.countDocuments(query),
        cartStatsAgg: () =>
          DailyStat.aggregate([
            { $match: query },
            {
              $group: {
                _id: null,
                totalSent: { $sum: '$abandonedCartSent' },
                totalClicks: { $sum: '$abandonedCartClicks' },
              },
            },
          ]),
        recoveryPurchasedAgg: () =>
          AdLead.aggregate([
            { $match: query },
            {
              $project: {
                count: {
                  $size: {
                    $filter: {
                      input: { $ifNull: ['$activityLog', []] },
                      as: 'log',
                      cond: { $eq: ['$$log.action', 'purchase_completed_after_recovery'] },
                    },
                  },
                },
              },
            },
            { $group: { _id: null, total: { $sum: '$count' } } },
          ]),
        adminFollowupsPurchased: () =>
          AdLead.countDocuments({
            ...query,
            adminFollowUpTriggered: true,
            isOrderPlaced: true,
          }),
        sentimentAgg: () =>
          Conversation.aggregate([
            { $match: query },
            { $group: { _id: '$sentiment', count: { $sum: 1 } } },
          ]),
      },
      'rebuild_parallel'
    );

    // Build sentiment counts
    const sentimentCounts = {
      Positive: 0, Neutral: 0, Negative: 0, Frustrated: 0, Urgent: 0, Unknown: 0
    };
    sentimentAgg.forEach(s => {
      const key = s._id || 'Unknown';
      if (sentimentCounts.hasOwnProperty(key)) {
        sentimentCounts[key] = s.count;
      } else {
        sentimentCounts.Unknown += s.count;
      }
    });

    const cacheData = {
      clientId,
      totalLeads,
      leadsToday,
      totalOrders,
      totalUnitsSold: totalUnitsSoldAgg[0]?.total || 0,
      ordersToday,
      unitsSoldToday: unitsSoldTodayAgg[0]?.total || 0,
      revenueToday: (orderRevenueTodayAgg[0]?.total || 0) + (appointmentRevenueTodayAgg[0]?.total || 0),
      appointmentsToday,
      appointmentRevenueToday: appointmentRevenueTodayAgg[0]?.total || 0,
      totalLinkClicks: linkClicksAgg[0]?.total || 0,
      totalAddToCarts: cartAddsAgg[0]?.total || 0,
      totalCheckouts: checkoutsAgg[0]?.total || 0,
      abandonedCarts,
      recoveredCarts,
      totalConversations,
      abandonedCartSent: cartStatsAgg[0]?.totalSent || 0,
      abandonedCartClicks: cartStatsAgg[0]?.totalClicks || 0,
      whatsappRecoveriesPurchased: recoveryPurchasedAgg[0]?.total || 0,
      adminFollowupsPurchased,
      sentimentCounts,
      lastRebuilt: new Date(),
      todayResetAt: today
    };

    await timer.time('StatCache.findOneAndUpdate', () =>
      StatCache.findOneAndUpdate({ clientId }, { $set: cacheData }, { upsert: true, new: true })
    );

    timer.finish('rebuild complete');
    log.info(`[rebuildCache] Rebuilt StatCache for ${clientId}`);
    return cacheData;
  } catch (err) {
    log.error(`[rebuildCache] Failed for ${clientId}:`, err.message);
    return null;
  }
}

/**
 * Reset daily counters at IST midnight.
 * 
 * @param {string} clientId
 */
async function dailyReset(clientId) {
  try {
    await StatCache.updateOne(
      { clientId },
      {
        $set: {
          leadsToday: 0,
          ordersToday: 0,
          unitsSoldToday: 0,
          revenueToday: 0,
          appointmentsToday: 0,
          appointmentRevenueToday: 0,
          todayResetAt: new Date()
        }
      }
    );
    log.info(`[dailyReset] Reset daily counters for ${clientId}`);
  } catch (err) {
    log.error(`[dailyReset] Failed for ${clientId}:`, err.message);
  }
}

/**
 * Get cached stats for a client.
 * If no cache exists, triggers a rebuild.
 * 
 * @param {string} clientId
 * @returns {object} stats
 */
async function getStats(clientId) {
  const { createTimer } = require('./perfLogger');
  const timer = createTimer('statCacheEngine.getStats', clientId);
  let stats = await timer.time('StatCache.findOne', () => StatCache.findOne({ clientId }).lean());

  if (!stats) {
    timer.log('cache=MISS — rebuilding');
    log.info(`[getStats] Cache miss for ${clientId}, rebuilding...`);
    stats = await timer.time('rebuildCache', () => rebuildCache(clientId));
    timer.finish(stats ? 'rebuilt' : 'rebuild_failed');
    return stats;
  }

  timer.finish('cache=HIT');
  return stats;
}

module.exports = {
  incrementStat,
  rebuildCache,
  dailyReset,
  getStats
};
