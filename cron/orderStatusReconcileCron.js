'use strict';

/**
 * Reconcile missed Shopify order-status automations when webhooks were dropped.
 * Tenant-scoped: each client polled with their own shopDomain + access token.
 * Dedup is enforced inside processOrderStatusAutomations via OrderStatusSent.
 */

const cron = require('node-cron');
const axios = require('axios');
const Client = require('../models/Client');
const shopifyAdminApiVersion = require('../utils/shopify/shopifyAdminApiVersion');
const { processOrderStatusAutomations } = require('../utils/commerce/orderStatusAutomationHandler');
const log = require('../utils/core/logger')('OrderStatusReconcileCron');

const LOOKBACK_HOURS = Number(process.env.ORDER_RECONCILE_LOOKBACK_HOURS || 24);
const MAX_ORDERS_PER_CLIENT = Number(process.env.ORDER_RECONCILE_LIMIT || 50);
const CLIENT_BATCH = Number(process.env.ORDER_RECONCILE_CLIENT_BATCH || 30);

async function reconcileClientOrders(client) {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const domain = String(client.shopDomain || '').replace(/^https?:\/\//, '').split('/')[0];
  if (!domain || !client.shopifyAccessToken) return { processed: 0 };

  const url = `https://${domain}/admin/api/${shopifyAdminApiVersion}/orders.json`;
  const res = await axios.get(url, {
    headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken },
    params: {
      status: 'any',
      updated_at_min: since,
      limit: MAX_ORDERS_PER_CLIENT,
      order: 'updated_at asc',
    },
    timeout: 20000,
  });

  const orders = res.data?.orders || [];
  let processed = 0;

  for (const payload of orders) {
    const result = await processOrderStatusAutomations({
      client,
      payload,
      source: 'order_status_reconcile_cron',
    }).catch((err) => {
      log.warn(`[OrderReconcile] ${client.clientId} order ${payload?.id}: ${err.message}`);
      return null;
    });
    if (result?.processed) processed += result.processed;
  }

  return { processed, ordersChecked: orders.length };
}

async function runOrderStatusReconcileTick() {
  try {
    const clients = await Client.find({
      shopifyAccessToken: { $exists: true, $ne: '' },
      shopDomain: { $exists: true, $ne: '' },
      isActive: { $ne: false },
    })
      .select('clientId shopDomain shopifyAccessToken commerceAutomations wizardFeatures')
      .limit(CLIENT_BATCH)
      .lean();

    if (!clients.length) return;

    let totalProcessed = 0;
    for (const client of clients) {
      try {
        const { processed, ordersChecked } = await reconcileClientOrders(client);
        totalProcessed += processed || 0;
        if (ordersChecked > 0) {
          log.info(
            `[OrderReconcile] ${client.clientId} checked=${ordersChecked} ruleRuns=${processed || 0}`
          );
        }
      } catch (err) {
        log.warn(`[OrderReconcile] client ${client.clientId} failed: ${err.message}`);
      }
    }

    if (totalProcessed > 0) {
      log.info(`[OrderReconcile] tick complete — ${totalProcessed} rule dispatches`);
    }
  } catch (err) {
    log.error('[OrderReconcile] tick error:', { error: err.message });
  }
}

const orderStatusReconcileCron = () => {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  cron.schedule('*/30 * * * *', runOrderStatusReconcileTick);
};

orderStatusReconcileCron.runTick = runOrderStatusReconcileTick;
module.exports = orderStatusReconcileCron;
