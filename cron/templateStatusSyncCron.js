"use strict";

/**
 * templateStatusSyncCron.js
 *
 * Enterprise-grade scheduled job that periodically syncs WhatsApp template
 * statuses from the Meta API for all active clients.
 *
 * Schedule: Every 6 hours + a dedicated nightly deep-sync at 3:30 AM IST.
 *
 * Logic:
 *  - Fetches all active clients who have a configured WABA ID and token.
 *  - For each client, fetches their template list from Meta Graph API.
 *  - Persists the result to `client.syncedMetaTemplates`.
 *  - Detects newly APPROVED or REJECTED templates and logs the state changes.
 *  - Prevents thundering herd by staggering requests across clients.
 */

const cron = require("node-cron");
const axios = require("axios");
const Client = require("../models/Client");
const log = require("../utils/logger")("TemplateStatusSync");
const { decrypt } = require("../utils/encryption");

const META_GRAPH_VERSION = "v21.0";
const STAGGER_MS = 400; // delay between clients to avoid rate-limits
const BATCH_SIZE = 15;  // max concurrent client syncs

/**
 * Fetch and persist templates for a single client.
 * Returns { checked, approved, rejected, errors }
 */
async function syncClientTemplates(client) {
  const result = { checked: 0, approved: 0, rejected: 0, errors: 0 };

  try {
    const wabaId = client.whatsapp?.wabaId || client.wabaId;
    const rawToken = client.whatsapp?.accessToken || client.whatsappToken;
    if (!wabaId || !rawToken) return result; // not configured

    let token;
    try {
      token = decrypt(rawToken);
    } catch {
      token = rawToken; // already plaintext (legacy)
    }

    if (!token) return result;

    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=250`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 12000,
    });

    const freshTemplates = response.data?.data || [];
    const oldTemplates = client.syncedMetaTemplates || [];

    // Detect status changes
    for (const fresh of freshTemplates) {
      const old = oldTemplates.find(o => o.name === fresh.name && o.language === fresh.language);
      if (old && old.status !== fresh.status) {
        if (fresh.status === "APPROVED") result.approved++;
        if (fresh.status === "REJECTED") result.rejected++;
        log.info(
          `[${client.clientId}] Template "${fresh.name}" status: ${old.status} → ${fresh.status}`
        );
      }
      result.checked++;
    }

    // Persist
    await Client.updateOne(
      { clientId: client.clientId },
      {
        $set: {
          syncedMetaTemplates: freshTemplates,
          templatesSyncedAt: new Date(),
        },
      }
    );

    return result;
  } catch (err) {
    // Handle specific Meta API errors
    if (err.response?.status === 190) {
      log.warn(`[${client.clientId}] WhatsApp token expired — skipping`);
    } else if (err.response?.status === 100) {
      log.warn(`[${client.clientId}] Invalid WABA ID — skipping`);
    } else {
      log.error(`[${client.clientId}] Sync failed: ${err.message}`);
    }
    result.errors++;
    return result;
  }
}

/**
 * Main sync runner — fetches all eligible clients and syncs in batches.
 */
async function runTemplateSync(label = "Scheduled") {
  log.info(`[TemplateSyncCron] ${label} run started`);
  const startedAt = Date.now();

  try {
    const clients = await Client.find(
      { isActive: true },
      "clientId whatsapp wabaId whatsappToken syncedMetaTemplates templatesSyncedAt"
    ).lean();

    const eligible = clients.filter(c => {
      const wabaId = c.whatsapp?.wabaId || c.wabaId;
      const token = c.whatsapp?.accessToken || c.whatsappToken;
      return !!(wabaId && token);
    });

    log.info(`[TemplateSyncCron] ${eligible.length} eligible clients found`);

    let totalChecked = 0;
    let totalApproved = 0;
    let totalRejected = 0;
    let totalErrors = 0;

    // Process in batches with stagger
    for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
      const batch = eligible.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(
        batch.map((client, idx) =>
          new Promise(resolve =>
            setTimeout(
              () => syncClientTemplates(client).then(resolve),
              idx * STAGGER_MS
            )
          )
        )
      );

      for (const r of results) {
        totalChecked += r.checked;
        totalApproved += r.approved;
        totalRejected += r.rejected;
        totalErrors += r.errors;
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log.info(
      `[TemplateSyncCron] ${label} complete in ${elapsed}s — Checked: ${totalChecked}, Approved: ${totalApproved}, Rejected: ${totalRejected}, Errors: ${totalErrors}`
    );
  } catch (err) {
    log.error(`[TemplateSyncCron] Fatal error in ${label} run: ${err.message}`);
  }
}

/**
 * Register cron jobs.
 */
function scheduleTemplateStatusSyncCron() {
  // Every 6 hours — light sync during the day
  cron.schedule("0 */6 * * *", () => runTemplateSync("6-hourly"), {
    timezone: "Asia/Kolkata",
  });

  // 3:30 AM IST — deep nightly sync (most comprehensive)
  cron.schedule("30 3 * * *", () => runTemplateSync("Nightly"), {
    timezone: "Asia/Kolkata",
  });

  log.info("[TemplateSyncCron] Scheduled: every 6h + nightly 3:30 AM IST");
}

// Export both the scheduler and the runner for on-demand use
module.exports = scheduleTemplateStatusSyncCron;
module.exports.runTemplateSync = runTemplateSync;
