'use strict';

const cron = require('node-cron');
const log = require('../utils/core/logger')('CodConfirmationCron');
const { processCodConfirmationTimeouts } = require('../utils/commerce/rtoProtectionService');

/**
 * Every 15 minutes: flag COD orders where customer never confirmed before deadline.
 * Outbound COD confirmation WhatsApp is sent from maybeSendCodConfirmationAfterOrderCreate
 * (rtoProtectionService) at order create — not from this cron tick.
 */
async function runCodConfirmationTick() {
  const io = global.io || null;
  const result = await processCodConfirmationTimeouts(io);
  if (result?.processed > 0) {
    log.info(`[COD] Processed ${result.processed} overdue confirmation(s)`);
  }
}

function scheduleCodConfirmationCron() {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runCodConfirmationTick();
    } catch (err) {
      log.error(`[COD] Timeout cron failed: ${err.message}`);
    }
  });
  log.info('[COD] Confirmation timeout cron scheduled (*/15 * * * *)');
}

scheduleCodConfirmationCron.runTick = runCodConfirmationTick;
module.exports = scheduleCodConfirmationCron;
