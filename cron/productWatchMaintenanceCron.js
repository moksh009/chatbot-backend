'use strict';

const cron = require('node-cron');
const ProductWatch = require('../models/ProductWatch');
const log = require('../utils/core/logger')('ProductWatchMaintenance');

function scheduleProductWatchMaintenance() {
  cron.schedule('0 3 * * 0', async () => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    try {
      const res = await ProductWatch.updateMany(
        {
          status: { $in: ['active', 'watching'] },
          watchedAt: { $lt: cutoff },
        },
        { $set: { status: 'expired', cancelledReason: 'timeout' } }
      );
      log.info(`Expired stale product watches: ${res.modifiedCount || 0}`);
    } catch (e) {
      log.error(`ProductWatch cleanup failed: ${e.message}`);
    }
  });
}

module.exports = scheduleProductWatchMaintenance;
