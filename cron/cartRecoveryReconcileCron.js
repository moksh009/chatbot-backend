'use strict';

/**
 * Backfill abandoned-cart recovery when webhooks/pixel miss a match.
 * - Light tick every 10m (coordinator bundle)
 * - Full nightly pass for all Shopify-connected tenants
 */

const cron = require('node-cron');
const Client = require('../models/Client');
const { reconcileOpenCartLeadsForClient } = require('../utils/commerce/cartRecoveryOrderReconcile');
const log = require('../utils/core/logger')('CartRecoveryReconcileCron');

const LOOKBACK_DAYS = Number(process.env.CART_RECONCILE_LOOKBACK_DAYS || 90);
const CLIENT_BATCH_LIGHT = Number(process.env.CART_RECONCILE_CLIENT_BATCH || 25);
const MAX_LEADS_LIGHT = Number(process.env.CART_RECONCILE_MAX_LEADS || 120);

async function fetchReconcileClients(limit) {
  return Client.find({
    shopifyAccessToken: { $exists: true, $ne: '' },
    shopDomain: { $exists: true, $ne: '' },
    isActive: { $ne: false },
  })
    .select('clientId')
    .limit(limit)
    .lean();
}

async function runCartRecoveryReconcileTick(options = {}) {
  const clientBatch = options.clientBatch ?? CLIENT_BATCH_LIGHT;
  const maxLeads = options.maxLeads ?? MAX_LEADS_LIGHT;
  const since =
    options.since instanceof Date
      ? options.since
      : new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const clients = await fetchReconcileClients(clientBatch);
  if (!clients.length) return { reconciled: 0, checked: 0, clients: 0 };

  let reconciled = 0;
  let checked = 0;

  for (const row of clients) {
    try {
      const out = await reconcileOpenCartLeadsForClient(row.clientId, { since, maxLeads });
      reconciled += out.reconciled || 0;
      checked += out.checked || 0;
      if (out.reconciled > 0) {
        log.info(
          `[CartRecoveryReconcile] ${row.clientId} reconciled=${out.reconciled} checked=${out.checked}`
        );
      }
    } catch (err) {
      log.warn(`[CartRecoveryReconcile] ${row.clientId} failed: ${err.message}`);
    }
  }

  if (reconciled > 0) {
    log.info(
      `[CartRecoveryReconcile] tick done clients=${clients.length} reconciled=${reconciled} checked=${checked}`
    );
  }

  return { reconciled, checked, clients: clients.length };
}

async function runCartRecoveryReconcileNightly() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const clients = await Client.find({
    shopifyAccessToken: { $exists: true, $ne: '' },
    shopDomain: { $exists: true, $ne: '' },
    isActive: { $ne: false },
  })
    .select('clientId')
    .lean();

  let reconciled = 0;
  let checked = 0;

  for (const row of clients) {
    try {
      const out = await reconcileOpenCartLeadsForClient(row.clientId, {
        since,
        maxLeads: 500,
      });
      reconciled += out.reconciled || 0;
      checked += out.checked || 0;
    } catch (err) {
      log.warn(`[CartRecoveryReconcile/nightly] ${row.clientId}: ${err.message}`);
    }
  }

  log.info(
    `[CartRecoveryReconcile/nightly] clients=${clients.length} reconciled=${reconciled} checked=${checked}`
  );
  return { reconciled, checked, clients: clients.length };
}

const cartRecoveryReconcileCron = () => {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  cron.schedule('*/30 * * * *', () => runCartRecoveryReconcileTick());
};

cartRecoveryReconcileCron.runTick = runCartRecoveryReconcileTick;
cartRecoveryReconcileCron.runNightly = runCartRecoveryReconcileNightly;

module.exports = cartRecoveryReconcileCron;
