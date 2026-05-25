"use strict";

/**
 * Phase 4 — Nightly catalog drift validation.
 * Compares shared template-catalog slots vs each client's synced Meta library.
 */

const cron = require("node-cron");
const log = require("../utils/core/logger")("TemplateCatalogValidation");
const { wrapCron } = require("../utils/core/perfLogger");
const { runCatalogValidationJob } = require("../constants/templateCatalog/validation");

async function runTemplateCatalogValidationTick() {
  log.info("Starting template catalog validation job…");
  const result = await runCatalogValidationJob({ limit: 500 });
  log.info(
    `[CatalogValidation] scanned=${result.scanned} needsAction=${result.needsActionTotal}`
  );
  return result;
}

function scheduleTemplateCatalogValidationCron() {
  cron.schedule(
    "15 4 * * *",
    wrapCron("Template catalog validation", runTemplateCatalogValidationTick),
    { timezone: "Asia/Kolkata" }
  );
  log.info("Template catalog validation cron registered (04:15 IST daily)");
}

scheduleTemplateCatalogValidationCron.runTick = runTemplateCatalogValidationTick;
module.exports = scheduleTemplateCatalogValidationCron;
