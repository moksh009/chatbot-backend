"use strict";

/**
 * Bundles overlapping node-cron schedules so fewer timers compete with WhatsApp webhooks.
 * Set CRON_USE_COORDINATOR=false to use legacy per-file schedules only.
 */

const cron = require("node-cron");
const log = require('../utils/core/logger')("CronCoordinator");
const { wrapCron } = require('../utils/core/perfLogger');

function registerCoordinatedCrons() {
  if (process.env.CRON_USE_COORDINATOR === "false") {
    log.info("CRON_USE_COORDINATOR=false — using legacy per-file cron timers only");
    return;
  }

  log.info("Registering coordinated cron bundles (2m / 5m / 10m / 15m)");

  cron.schedule(
    "*/2 * * * *",
    wrapCron("Coordinator/2min scheduled messages", async () => {
      const scheduleScheduled = require("./scheduledMessageCron");
      if (scheduleScheduled.runTick) await scheduleScheduled.runTick();
      try {
        const codExpire = require("./codToPrepaidExpirationCron");
        if (codExpire.runTick) await codExpire.runTick();
      } catch (_) {}
    })
  );

  cron.schedule(
    "*/5 * * * *",
    wrapCron("Coordinator/5min abandoned+sequences+campaigns", async () => {
      const abandoned = require("./abandonedCartScheduler");
      const sequences = require("./followUpSequenceCron");
      const campaigns = require("./campaignSchedulerCron");

      // Sequential — avoids 3 heavy cron ticks grabbing the whole Mongo pool at :05
      if (abandoned.runTick) await abandoned.runTick();
      if (sequences.runTick) await sequences.runTick();
      if (campaigns.runTick) await campaigns.runTick();
    })
  );

  cron.schedule(
    "*/10 * * * *",
    wrapCron("Coordinator/10min reconcile+CSAT primary", async () => {
      try {
        const reconcile = require("./orderStatusReconcileCron");
        if (reconcile.runTick) await reconcile.runTick();
      } catch (_) {}

      try {
        const cartReconcile = require("./cartRecoveryReconcileCron");
        if (cartReconcile.runTick) await cartReconcile.runTick();
      } catch (_) {}

      const scheduleCsat = require("./csatCron");
      if (scheduleCsat.runPrimaryTick) {
        await scheduleCsat.runPrimaryTick();
      }
    })
  );

  cron.schedule(
    "*/15 * * * *",
    wrapCron("Coordinator/15min COD+autoResume+CSAT secondary", async () => {
      try {
        const scheduleCod = require("./codConfirmationCron");
        if (scheduleCod.runTick) await scheduleCod.runTick();
      } catch (_) {}

      try {
        const codPrepaid = require("./codPrepaidNudgeCron");
        if (codPrepaid.runTick) await codPrepaid.runTick();
      } catch (_) {}

      try {
        const scheduleAutoResume = require("./autoResumeBotCron");
        if (scheduleAutoResume.runTick) await scheduleAutoResume.runTick();
      } catch (_) {}

      try {
        const scheduleCsat = require("./csatCron");
        if (scheduleCsat.runSecondaryTick) await scheduleCsat.runSecondaryTick();
      } catch (_) {}
    })
  );
}

module.exports = { registerCoordinatedCrons };
