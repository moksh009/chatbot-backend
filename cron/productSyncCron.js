const cron = require('node-cron');
const axios = require('axios');
const Client = require('../models/Client');
const log = require('../utils/logger')('ProductSyncCron');

/**
 * Daily Product Sync Cron
 * Runs at 02:00 AM IST (20:30 UTC previous day)
 */
const scheduleProductSyncCron = () => {
    cron.schedule('30 20 * * *', async () => {
        log.info('Starting daily Shopify product sync...');
        try {
            const ecomClients = await Client.find({ 
                niche: 'ecommerce', 
                shopifyAccessToken: { $exists: true, $ne: '' } 
            });

            log.info(`Found ${ecomClients.length} e-commerce clients to sync.`);

            for (const client of ecomClients) {
                try {
                    log.info(`Syncing products for ${client.clientId} (${client.shopDomain})...`);
                    
                    const response = await axios.get(
                        `https://${client.shopDomain}/admin/api/2024-01/products.json?limit=250`,
                        { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
                    );

                    const products = response.data.products.map(p => ({
                        id: p.id,
                        title: p.title,
                        handle: p.handle,
                        price: p.variants[0]?.price,
                        image: p.image?.src,
                        url: `https://${client.shopDomain}/products/${p.handle}`
                    }));

                    await Client.findOneAndUpdate(
                        { clientId: client.clientId },
                        { $set: { "nicheData.products": products } }
                    );
                    
                    log.success(`Successfully synced ${products.length} products for ${client.clientId}`);
                    
                    // Throttle to avoid hitting Shopify API limits across many clients
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (err) {
                    log.error(`Failed to sync products for ${client.clientId}:`, err.response?.data || err.message);
                }
            }
            log.info('Daily Shopify product sync completed.');
        } catch (e) {
            log.error('Product Sync Cron Error:', e);
        }
    });
};

module.exports = scheduleProductSyncCron;
