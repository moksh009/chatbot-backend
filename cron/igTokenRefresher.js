const cron = require("node-cron");
const axios = require("axios");
const Client = require("../models/Client");
const { encrypt, decrypt } = require("../utils/encryption");
const { wrapCron } = require("../utils/perfLogger");
const log = require("../utils/logger")("IGTokenRefresher");

function scheduleIgTokenRefresher() {
  cron.schedule(
    "0 3 * * *",
    wrapCron("IG token refresher (legacy)", async () => {
      log.info("Starting daily Instagram token refresher");
      const now = new Date();
      const threshold = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      const clients = await Client.find({
        igAccessToken: { $ne: null },
        igTokenExpiry: { $lt: threshold, $ne: null },
      })
        .select("clientId igAccessToken igTokenExpiry")
        .lean();

      for (const client of clients) {
        try {
          const oldToken = decrypt(client.igAccessToken);
          const response = await axios.get("https://graph.facebook.com/v21.0/refresh_access_token", {
            params: {
              grant_type: "ig_refresh_token",
              access_token: oldToken,
            },
          });

          if (response.data?.access_token) {
            const newToken = encrypt(response.data.access_token);
            const expiresIn = response.data.expires_in || 5184000;
            const newExpiry = new Date(Date.now() + expiresIn * 1000);
            await Client.updateOne(
              { clientId: client.clientId },
              { $set: { igAccessToken: newToken, igTokenExpiry: newExpiry } }
            );
          }
        } catch (err) {
          log.warn(`Token refresh failed for ${client.clientId}:`, err.message);
        }
      }
    })
  );
}

module.exports = scheduleIgTokenRefresher;
