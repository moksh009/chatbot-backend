const cron = require('node-cron');
const Client = require('../models/Client');
const Order = require('../models/Order');
const AmazonSPAPI = require('../utils/amazonSPAPI');
const log = require('../utils/logger')('AmazonSync');
const { trackEcommerceEvent } = require('../utils/analyticsHelper');
const { processOrderForLoyalty } = require('../utils/walletService');


/**
 * Amazon Order Sync Cron (Phase 2 Foundation)
 * Runs every 30 minutes to fetch new Amazon orders and trigger CRM/Loyalty logic.
 */
const scheduleAmazonSync = () => {
    cron.schedule('*/30 * * * *', async () => {
        log.info('Running Amazon SP-API Order Sync...');
        
        try {
            // Find clients with Amazon credentials configured
            const clients = await Client.find({ 
                'amazonConfig.refreshToken': { $exists: true },
                'isActive': true 
            });

            for (const client of clients) {
                const amazon = new AmazonSPAPI(client.amazonConfig);
                const marketplaceId = client.amazonConfig.marketplaceId || 'A21TJ7DG3Y56XX'; // Default India
                
                const amazonOrders = await amazon.getOrders(marketplaceId);
                
                for (const amzOrder of amazonOrders) {
                    // Check if order already exists
                    const existing = await Order.findOne({ orderId: amzOrder.AmazonOrderId, clientId: client.clientId });
                    if (existing) continue;

                    log.info(`New Amazon Order detected: ${amzOrder.AmazonOrderId} for ${client.clientId}`);

                    // Fetch items for SKU triggers
                    const items = await amazon.getOrderItems(amzOrder.AmazonOrderId);
                    
                    // Create internal order
                    const newOrder = await Order.create({
                        clientId: client.clientId,
                        orderId: amzOrder.AmazonOrderId,
                        customerName: amzOrder.BuyerInfo?.BuyerName || 'Amazon Customer',
                        customerPhone: amzOrder.BuyerInfo?.BuyerPhone || '', // Amazon often masks this, but SP-API may provide it depending on PII permissions
                        amount: parseFloat(amzOrder.OrderTotal?.Amount || 0),
                        status: amzOrder.OrderStatus,
                        source: 'amazon',
                        items: items.map(i => ({
                            name: i.Title,
                            sku: i.SellerSKU,
                            quantity: i.QuantityOrdered,
                            price: parseFloat(i.ItemPrice?.Amount || 0)
                        })),
                        createdAt: amzOrder.PurchaseDate
                    });

                    // Trigger SKU Automations (Shared with Shopify logic)
                    if (client.skuAutomations?.length > 0 && newOrder.customerPhone) {
                        const WhatsApp = require('../utils/whatsapp');
                        for (const item of items) {
                            const automation = client.skuAutomations.find(a => 
                                a.sku === item.SellerSKU && a.isActive && a.triggerEvent === 'paid'
                            );

                            if (automation) {
                                WhatsApp.sendSmartTemplate(
                                    client,
                                    newOrder.customerPhone,
                                    automation.templateName,
                                    [newOrder.customerName, item.Title],
                                    automation.imageUrl
                                ).catch(e => log.error('Amazon SKU trigger failed:', e.message));
                            }
                        }
                    }

                    // Integration Hook: Award Loyalty Points for Amazon Orders
                    if (newOrder.customerPhone && newOrder.amount > 0) {
                        processOrderForLoyalty(
                            client.clientId, 
                            newOrder.customerPhone, 
                            newOrder.amount, 
                            newOrder.orderId
                        ).catch(e => log.error('Amazon loyalty credit failed:', e.message));
                    }

                    await trackEcommerceEvent(client.clientId, { amazonOrdersSynced: 1 });

                }
            }
        } catch (err) {
            log.error('Amazon Sync Job failed:', err.message);
        }
    });
};

module.exports = scheduleAmazonSync;
