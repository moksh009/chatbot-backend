const cron = require('node-cron');
const axios = require('axios');
const Client = require('../models/Client');
const { encrypt, decrypt } = require('../utils/encryption');

// Run daily at 3:00 AM IST
cron.schedule('0 3 * * *', async () => {
  console.log('[CRON] Starting Daily Instagram Token Refresher');

  const now = new Date();
  const threshold = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

  try {
    const clients = await Client.find({
      igAccessToken: { $ne: null },
      igTokenExpiry: { $lt: threshold, $ne: null }
    }).select('clientId igAccessToken igTokenExpiry');

    console.log(`[CRON] Found ${clients.length} tokens expiring in the next 7 days.`);

    for (const client of clients) {
      try {
        const oldToken = decrypt(client.igAccessToken);
        const response = await axios.get('https://graph.facebook.com/v21.0/refresh_access_token', {
          params: {
            grant_type: 'ig_refresh_token',
            access_token: oldToken
          }
        });

        const data = response.data;
        if (data.access_token) {
          const newExpiry = new Date(now.getTime() + (data.expires_in || 5184000) * 1000); // default ~60 days
          await Client.updateOne(
            { _id: client._id },
            {
              $set: {
                igAccessToken: encrypt(data.access_token),
                igTokenExpiry: newExpiry
              }
            }
          );
          console.log(`[CRON] Successfully refreshed token for clientId: ${client.clientId}. New expiry: ${newExpiry}`);
        }
      } catch (err) {
        console.error(`[CRON] Failed to refresh token for clientId: ${client.clientId}`, err.response?.data || err.message);
        // Do not delete token immediately; let the user see the expired alert
      }
    }
  } catch (err) {
    console.error('[CRON] Error running token refresher job:', err);
  }
}, {
  timezone: "Asia/Kolkata"
});
