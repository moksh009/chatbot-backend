const cron = require("node-cron");
const Client = require("../models/Client");
const { log } = require("../utils/logger");
const wizardRouter = require("../routes/wizard");

function scheduleTemplateStatusSyncCron() {
  cron.schedule("30 3 * * *", async () => {
    try {
      const clients = await Client.find({
        isActive: true
      });

      let totalApproved = 0;
      let totalChecked = 0;

      for (const client of clients) {
        if (!Array.isArray(client.pendingTemplates) || client.pendingTemplates.length === 0) continue;
        try {
          const result = await wizardRouter.syncPendingTemplatesForClient(client);
          totalApproved += result.approved || 0;
          totalChecked += result.checked || 0;
        } catch (err) {
          log.error(`[TemplateSyncCron] Failed for ${client.clientId}: ${err.message}`);
        }
      }

      log.info(`[TemplateSyncCron] Completed. Checked=${totalChecked}, newlyApproved=${totalApproved}`);
    } catch (err) {
      log.error(`[TemplateSyncCron] Job failed: ${err.message}`);
    }
  }, {
    timezone: "Asia/Kolkata"
  });
}

module.exports = scheduleTemplateStatusSyncCron;
