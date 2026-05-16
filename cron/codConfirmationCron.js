'use strict';

const cron = require('node-cron');
const log = require('../utils/logger')('CodConfirmationCron');
const { processCodConfirmationTimeouts } = require('../utils/rtoProtectionService');

/**
 * Every 15 minutes: flag COD orders where customer never confirmed before deadline.
 */
function scheduleCodConfirmationCron() {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const io = global.io || null;
      const result = await processCodConfirmationTimeouts(io);
      if (result?.processed > 0) {
        log.info(`[COD] Processed ${result.processed} overdue confirmation(s)`);
      }
    } catch (err) {
      log.error(`[COD] Timeout cron failed: ${err.message}`);
    }
  });
  log.info('[COD] Confirmation timeout cron scheduled (*/15 * * * *)');
}

module.exports = scheduleCodConfirmationCron;
