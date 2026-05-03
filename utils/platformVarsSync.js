"use strict";

const Client = require("../models/Client");
const log = require("./logger")("PlatformVarsSync");

/**
 * Marks platform vars as synced after wizard / settings updates so jobs know data is fresh.
 */
async function syncPlatformVarsToFlows(clientId) {
  if (!clientId) return { ok: false, error: "clientId required" };
  try {
    await Client.updateOne(
      { clientId },
      { $set: { "platformVars.lastSyncedAt": new Date() } }
    );
    return { ok: true };
  } catch (e) {
    log.error(`syncPlatformVarsToFlows failed for ${clientId}`, e);
    return { ok: false, error: e.message };
  }
}

module.exports = { syncPlatformVarsToFlows };
