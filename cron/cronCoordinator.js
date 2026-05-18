"use strict";

/**
 * Bundles overlapping node-cron schedules so fewer timers compete with WhatsApp webhooks.
 * Set CRON_USE_COORDINATOR=false to use legacy per-file schedules only.
 */

const cron = require("node-cron");
const log = require("../utils/logger")("CronCoordinator");

function registerCoordinatedCrons() {
  if (process.env.CRON_USE_COORDINATOR === "false") {
    log.info("CRON_USE_COORDINATOR=false — using legacy per-file cron timers only");
    return;
  }

  log.info("Registering coordinated cron bundles (2m / 5m / 10m / 15m)");

  cron.schedule("*/2 * * * *", async () => {
    const start = Date.now();
    try {
      const scheduleScheduled = require("./scheduledMessageCron");
      if (scheduleScheduled.runTick) await scheduleScheduled.runTick();
    } catch (err) {
      log.error("[Cron/2min] scheduled messages:", err.message);
    }
    log.info(`[Cron/2min] finished in ${Date.now() - start}ms`);
  });

  cron.schedule("*/5 * * * *", async () => {
    const start = Date.now();
    const abandoned = require("./abandonedCartScheduler");
    const sequences = require("./followUpSequenceCron");
    const campaigns = require("./campaignSchedulerCron");

    await Promise.allSettled([
      abandoned.runTick?.(),
      sequences.runTick?.(),
      campaigns.runTick?.(),
    ]);

    log.info(`[Cron/5min] finished in ${Date.now() - start}ms`);
  });

  cron.schedule("*/10 * * * *", async () => {
    const start = Date.now();
    const tasks = [];

    try {
      const scheduleCsat = require("./csatCron");
      if (scheduleCsat.runPrimaryTick) {
        tasks.push(
          scheduleCsat.runPrimaryTick().catch((err) => {
            log.error("CSAT primary:", err.message);
          })
        );
      }
    } catch (_) {}

    await Promise.allSettled(tasks);
    log.info(`[Cron/10min] finished in ${Date.now() - start}ms`);
  });

  cron.schedule("*/15 * * * *", async () => {
    const start = Date.now();
    const tasks = [];

    try {
      const scheduleCod = require("./codConfirmationCron");
      if (scheduleCod.runTick) tasks.push(scheduleCod.runTick());
    } catch (_) {}

    try {
      const scheduleAutoResume = require("./autoResumeBotCron");
      if (scheduleAutoResume.runTick) tasks.push(scheduleAutoResume.runTick());
    } catch (_) {}

    try {
      const scheduleCsat = require("./csatCron");
      if (scheduleCsat.runSecondaryTick) tasks.push(scheduleCsat.runSecondaryTick());
    } catch (_) {}

    await Promise.allSettled(tasks);
    log.info(`[Cron/15min] finished in ${Date.now() - start}ms`);
  });
}

module.exports = { registerCoordinatedCrons };
