const cron = require("node-cron");
const { recomputeAllScores } = require("../utils/leadScoring");
const Client = require("../models/Client");
const logger = require("../utils/logger")('LeadScoringCron');

// Run at 2:30 AM IST (21:00 UTC) every day
cron.schedule("0 21 * * *", async () => {
  logger.info("Starting nightly recompute...");
  const clients = await Client.find({ isActive: true })
    .select("_id clientId").lean();
  
  for (const client of clients) {
    await recomputeAllScores(client.clientId);
    await new Promise(r => setTimeout(r, 500)); // space between clients
  }
  logger.info("All clients recomputed.");
});
