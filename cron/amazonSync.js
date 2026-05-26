const cron = require('node-cron');
const Client = require('../models/Client');
const Order = require('../models/Order');
const AmazonSPAPI = require('../utils/commerce/amazonSPAPI');
const log = require('../utils/core/logger')('AmazonSync');
const { trackEcommerceEvent } = require('../utils/core/analyticsHelper');
const { processOrderForLoyalty } = require('../utils/commerce/walletService');
const { applyAdjustment, autoMatchSkuMapping } = require('../utils/inventory/ledger');

const PENDING_STATUSES = new Set(['Pending', 'Unshipped']);
const SHIPPED_STATUSES = new Set(['Shipped', 'PartiallyShipped']);
const CANCELLED_STATUSES = new Set(['Canceled', 'Cancelled']);

/**
 * Amazon Order Sync — enabled when client has amazonConfig.refreshToken.
 * Decrements inventory ledger idempotently per line item.
 */
const scheduleAmazonSync = () => {
  if (process.env.CRON_ENABLE_INVENTORY === 'false') return;

  cron.schedule('*/15 * * * *', async () => {
    log.info('Running Amazon SP-API Order Sync...');

    try {
      const clients = await Client.find({
        'amazonConfig.refreshToken': { $exists: true },
        isActive: true,
      });

      for (const client of clients) {
        const amazon = new AmazonSPAPI(client.amazonConfig);
        const marketplaceId = client.amazonConfig.marketplaceId || 'A21TJ7DG3Y56XX';

        const amazonOrders = await amazon.getOrders(marketplaceId);

        for (const amzOrder of amazonOrders) {
          const orderId = amzOrder.AmazonOrderId;
          const existing = await Order.findOne({ orderId, clientId: client.clientId });
          if (existing) continue;

          log.info(`New Amazon Order detected: ${orderId} for ${client.clientId}`);

          const items = await amazon.getOrderItems(orderId);
          const status = amzOrder.OrderStatus || 'Unshipped';

          const newOrder = await Order.create({
            clientId: client.clientId,
            orderId,
            customerName: amzOrder.BuyerInfo?.BuyerName || 'Amazon Customer',
            customerPhone: amzOrder.BuyerInfo?.BuyerPhone || '',
            amount: parseFloat(amzOrder.OrderTotal?.Amount || 0),
            status,
            source: 'amazon',
            storeKey: `amazon:${client.amazonConfig.sellerId || 'default'}`,
            items: items.map((i) => ({
              name: i.Title,
              sku: i.SellerSKU,
              quantity: i.QuantityOrdered,
              price: parseFloat(i.ItemPrice?.Amount || 0),
            })),
            createdAt: amzOrder.PurchaseDate,
          });

          for (const item of items) {
            const sellerSku = item.SellerSKU;
            const qty = Number(item.QuantityOrdered) || 1;
            const lineId = item.OrderItemId || sellerSku;
            const mapping = await autoMatchSkuMapping(client.clientId, sellerSku);

            if (!mapping) {
              log.warn(`Unmapped Amazon SKU ${sellerSku} on order ${orderId}`);
              const { alertUnmappedAmazonSku } = require('../utils/inventory/inventoryAlerts');
              await alertUnmappedAmazonSku(client.clientId, sellerSku, orderId).catch(() => {});
              continue;
            }

            const internalSku = mapping.internalSku;
            const idempotencyKey = `${orderId}:${lineId}:${status}`;

            if (PENDING_STATUSES.has(status)) {
              const { reserveStock } = require('../utils/inventory/ledger');
              await reserveStock({
                clientId: client.clientId,
                sku: internalSku,
                qty,
                source: 'amazon_order',
                sourceRef: orderId,
                idempotencyKey: `reserve:${idempotencyKey}`,
              });
            } else if (SHIPPED_STATUSES.has(status)) {
              await applyAdjustment({
                clientId: client.clientId,
                sku: internalSku,
                delta: -qty,
                reason: 'other',
                source: 'amazon_order',
                sourceRef: orderId,
                idempotencyKey,
                skipShopifyPush: false,
              });
            } else if (CANCELLED_STATUSES.has(status)) {
              const { releaseReservation } = require('../utils/inventory/ledger');
              await releaseReservation({
                clientId: client.clientId,
                sku: internalSku,
                qty,
                source: 'amazon_order',
                sourceRef: orderId,
                idempotencyKey: `cancel:${idempotencyKey}`,
              });
            }
          }

          if (client.skuAutomations?.length > 0 && newOrder.customerPhone) {
            const SkuTriggerService = require('../utils/commerce/skuTriggerService');
            await SkuTriggerService.processTriggers(
              {
                orderId: newOrder.orderId,
                customerPhone: newOrder.customerPhone,
                customerName: newOrder.customerName,
                items: items.map((i) => ({ sku: i.SellerSKU, name: i.Title })),
              },
              'paid',
              client
            ).catch((e) => log.error('Amazon SKU trigger failed:', e.message));
          }

          if (newOrder.customerPhone && newOrder.amount > 0) {
            processOrderForLoyalty(
              client.clientId,
              newOrder.customerPhone,
              newOrder.amount,
              newOrder.orderId
            ).catch((e) => log.error('Amazon loyalty credit failed:', e.message));
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
