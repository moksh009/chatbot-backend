"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const Client = require("../models/Client");
const { migrateLegacyClientTemplatesToMeta } = require("../services/templateLifecycleService");

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clients = await Client.find({}, "clientId").lean();
  let totalMigrated = 0;
  for (const client of clients) {
    const result = await migrateLegacyClientTemplatesToMeta(client.clientId);
    totalMigrated += result.migrated;
    // eslint-disable-next-line no-console
    console.log(`[TemplateMigration] ${client.clientId}: ${result.migrated}/${result.total}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[TemplateMigration] Completed. Migrated templates: ${totalMigrated}`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error("[TemplateMigration] Failed:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
