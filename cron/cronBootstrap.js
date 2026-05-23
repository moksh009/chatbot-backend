"use strict";

/**
 * Single cron registration point — avoids duplicate timers and documents tiers.
 * Set RUN_CRONS=false for API-only local dev (see scripts/start-api-dev.sh).
 */
const cron = require("node-cron");
const log = require("../utils/logger")("CronBootstrap");
const { wrapCron } = require("../utils/perfLogger");
const Client = require("../models/Client");

function envFlag(name, defaultOn = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultOn;
  return v === "true" || v === "1";
}

async function purgeLegacySequencesOnBoot() {
  try {
    const { cancelLegacyFollowUpSequences } = require("../config/ecommerceOnlyPolicy");
    await cancelLegacyFollowUpSequences({ reason: "ecommerce_only_boot" });
  } catch (err) {
    log.warn("Legacy sequence purge skipped", { message: err.message });
  }
}

function registerAllCrons() {
  if (process.env.RUN_CRONS === "false") {
    log.info("RUN_CRONS=false — skipping all cron registration");
    return;
  }

  purgeLegacySequencesOnBoot();

  if (process.env.CRON_USE_COORDINATOR !== "false") {
    process.env.CRON_USE_COORDINATOR = "true";
    const { registerCoordinatedCrons } = require("./cronCoordinator");
    registerCoordinatedCrons();
    log.info("Coordinated cron bundles: 2m / 5m / 10m / 15m (mongo budget applied)");
  } else {
    log.info("CRON_USE_COORDINATOR=false — legacy per-file schedules");
  }

  // ── High frequency (flow) — every 2 min by default (was every 1 min) ──
  require("./flowResumptionCron")();

  // ── Legacy noop stubs (register runTick only; timers skipped when coordinator on) ──
  require("./abandonedCartScheduler")();
  require("./codConfirmationCron")();
  require("./autoResumeBotCron")();
  require("./followUpSequenceCron")();
  require("./campaignSchedulerCron")();
  require("./csatCron")();
  if (process.env.CRON_USE_COORDINATOR === "false") {
    require("./scheduledMessageCron")();
  }

  // ── Daily / hourly maintenance (low overlap) ──
  require("./loyaltyCron")();
  require("./statCacheCron")();
  require("./checkoutLinkRecoveryCron")();
  require("./reviewCollection")();
  if (envFlag("CRON_ENABLE_BIRTHDAY", false)) {
    require("./birthdayCron")();
    log.info("Birthday cron enabled (CRON_ENABLE_BIRTHDAY=true)");
  } else {
    log.info("Birthday cron disabled — set CRON_ENABLE_BIRTHDAY=true to enable");
  }
  require("./productSyncCron")();
  require("./templateStatusSyncCron")();
  require("./insightsCron")();
  if (envFlag("CRON_ENABLE_AB_TEST_LEGACY", false)) {
    require("./abTestCron")();
    log.info("Legacy hourly A/B evaluator enabled (CRON_ENABLE_AB_TEST_LEGACY=true)");
  }

  const scheduleLeadScoringCron = require("./leadScoringCron");
  if (typeof scheduleLeadScoringCron === "function") scheduleLeadScoringCron();

  const scheduleIgTokenRefresher = require("./igTokenRefresher");
  if (typeof scheduleIgTokenRefresher === "function") scheduleIgTokenRefresher();

  const scheduleAutoResolutionCron = require("./autoResolutionCron");
  if (typeof scheduleAutoResolutionCron === "function") scheduleAutoResolutionCron();

  // ── Optional heavy / niche (off by default in dev) ──
  if (envFlag("CRON_ENABLE_AMAZON_SYNC", false)) {
    require("./amazonSync")();
    log.info("Amazon SP-API sync cron enabled");
  }

  if (envFlag("CRON_ENABLE_AB_WINNER", false)) {
    const scheduleAbTestWinner = require("./abTestWinner");
    if (typeof scheduleAbTestWinner === "function") scheduleAbTestWinner();
    log.info("A/B winner evaluation cron enabled");
  }

  // ── Daily IST jobs (index.js previously inline) ──
  const { resetDailyErrorCounts } = require("../utils/autoHealer");
  cron.schedule("0 0 * * *", wrapCron("resetDailyErrorCounts", resetDailyErrorCounts));

  const { refreshExpiringInstagramTokens } = require("../routes/oauth");
  cron.schedule(
    "0 8 * * *",
    wrapCron("Instagram token refresh", async () => {
      log.info("[Cron] Instagram token refresh (oauth path)...");
      await refreshExpiringInstagramTokens();
    }),
    { timezone: "Asia/Kolkata" }
  );

  const { syncMetaAds } = require("../utils/metaAdsAPI");
  cron.schedule(
    "0 6 * * *",
    wrapCron("Meta Ads daily sync", async () => {
      const connectedClients = await Client.find({ metaAdsConnected: true, isActive: true })
        .select("clientId")
        .lean();
      for (const c of connectedClients) {
        syncMetaAds(c.clientId).catch((err) =>
          log.error(`[MetaAds] Cron sync error for ${c.clientId}:`, { error: err.message })
        );
      }
    }),
    { timezone: "Asia/Kolkata" }
  );

  // Self-ping — Render/production only (no local pool noise)
  const serverUrl = String(process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL || "").trim();
  if (envFlag("ENABLE_SELF_PING", !!serverUrl) && serverUrl) {
    cron.schedule(
      "*/14 * * * *",
      wrapCron("Self-Ping keepalive", () => {
        const https = require("https");
        const url = `${serverUrl.replace(/\/$/, "")}/keepalive-ping`;
        log.info(`[Self-Ping] ${url}`);
        https
          .get(url, (resp) => {
            let data = "";
            resp.on("data", (chunk) => {
              data += chunk;
            });
            resp.on("end", () => log.info("[Self-Ping] awake!", { data: data.slice(0, 120) }));
          })
          .on("error", (err) => log.error("[Self-Ping] Error:", { message: err.message }));
      })
    );
  } else {
    log.info("Self-ping cron disabled (set SERVER_URL or ENABLE_SELF_PING=true to enable)");
  }

  log.info("Cron bootstrap complete");
}

module.exports = { registerAllCrons };
