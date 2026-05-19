const cron = require("node-cron");
const { recomputeAllScores } = require("../utils/leadScoring");
const Client = require("../models/Client");
const logger = require("../utils/logger")("LeadScoringCron");
const { wrapCron } = require("../utils/perfLogger");

function scheduleLeadScoringCron() {
  cron.schedule(
    "0 21 * * *",
    wrapCron("Lead scoring nightly", async () => {
      logger.info("Starting nightly recompute...");
      const clients = await Client.find({ isActive: true }).select("_id clientId").lean();

      for (const client of clients) {
        await recomputeAllScores(client.clientId);
        await new Promise((r) => setTimeout(r, 500));
      }
      logger.info("All clients recomputed.");
    })
  );
}

module.exports = scheduleLeadScoringCron;
