const cron = require('node-cron');
const Client = require('../models/Client');
const { refreshShopifyToken } = require('../utils/shopifyHelper');

// This cron job runs every day at midnight
cron.schedule('0 0 * * *', async () => {
  console.log('Running Shopify token refresh cron job...');
  try {
    const clients = await Client.find({ 'shopify.accessToken': { $exists: true } });
    for (const client of clients) {
      // Check if the token is expiring soon (e.g., within the next 7 days)
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (client.shopify.expiresAt - Date.now() < sevenDays) {
        console.log(`Refreshing Shopify token for client: ${client.clientId}`);
        await refreshShopifyToken(client);
      }
    }
  } catch (error) {
    console.error('Error refreshing Shopify tokens:', error);
  }
});