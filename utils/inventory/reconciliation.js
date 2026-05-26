'use strict';

const Client = require('../../models/Client');
const ShopifyProduct = require('../../models/ShopifyProduct');
const InventoryLedger = require('../../models/InventoryLedger');
const { applyAdjustment } = require('./ledger');
const { createInventoryAlert } = require('./inventoryAlerts');
const log = require('../core/logger')('InventoryReconciliation');

const AUTO_CORRECT_MAX = Number(process.env.INVENTORY_RECON_AUTO_CORRECT_MAX || 5);
const ALERT_DRIFT_MIN = Number(process.env.INVENTORY_RECON_ALERT_MIN || 10);

/**
 * Compare ledger.available vs Shopify catalog qty per SKU; auto-correct small drift.
 */
async function reconcileClientInventory(clientId) {
  const client = await Client.findOne({ clientId })
    .select('shopDomain shopifyAccessToken amazonConfig inventoryConfig')
    .lean();

  const { reconcileByTruthSource } = require('./truthSourceReconciliation');
  const truthResult = await reconcileByTruthSource(clientId).catch(() => ({ corrections: [] }));

  if (!client?.shopifyAccessToken) {
    return { skipped: true, reason: 'no_shopify', truthCorrections: truthResult.corrections?.length || 0 };
  }

  const products = await ShopifyProduct.find({ clientId, sku: { $ne: '' } })
    .select('sku inventoryQuantity')
    .lean();
  const ledgers = await InventoryLedger.find({ clientId, locationId: 'default' }).lean();
  const ledgerMap = new Map(ledgers.map((l) => [l.sku, l]));

  const drifts = [];
  let corrected = 0;

  for (const p of products) {
    const shopifyQty = Number(p.inventoryQuantity) || 0;
    let ledger = ledgerMap.get(p.sku);
    if (!ledger) {
      ledger = await InventoryLedger.create({
        clientId,
        sku: p.sku,
        locationId: 'default',
        available: shopifyQty,
        reserved: 0,
        lastShopifySync: { at: new Date(), qty: shopifyQty },
      });
      ledgerMap.set(p.sku, ledger);
      continue;
    }

    const ledgerQty = Number(ledger.available) || 0;
    const drift = ledgerQty - shopifyQty;
    if (drift === 0) continue;

    drifts.push({ sku: p.sku, ledgerQty, shopifyQty, drift });

    if (Math.abs(drift) <= AUTO_CORRECT_MAX) {
      await applyAdjustment({
        clientId,
        sku: p.sku,
        delta: -drift,
        reason: 'reconciliation',
        source: 'reconciliation',
        sourceRef: `recon:${new Date().toISOString().slice(0, 10)}`,
        idempotencyKey: `recon:${clientId}:${p.sku}:${shopifyQty}:${new Date().toISOString().slice(0, 10)}`,
        skipShopifyPush: Math.abs(drift) < 1,
      });
      corrected += 1;
    } else if (Math.abs(drift) >= ALERT_DRIFT_MIN) {
      await createInventoryAlert(clientId, {
        type: 'drift_detected',
        title: `Inventory drift on ${p.sku}`,
        message: `Ledger shows ${ledgerQty} but Shopify shows ${shopifyQty} (${drift > 0 ? '+' : ''}${drift} units). Review and adjust.`,
        metadata: { sku: p.sku, ledgerQty, shopifyQty, drift },
      });
    }
  }

  await InventoryLedger.updateMany(
    { clientId },
    { $set: { 'lastReconciliation.at': new Date() } }
  );

  log.info(`Reconciliation ${clientId}: ${drifts.length} drifts, ${corrected} auto-corrected`);
  return {
    clientId,
    driftCount: drifts.length,
    corrected,
    drifts: drifts.slice(0, 50),
    truthCorrections: truthResult.corrections?.length || 0,
  };
}

async function runReconciliationForAllClients() {
  const clients = await Client.find({
    shopifyAccessToken: { $exists: true, $ne: '' },
    isActive: true,
  })
    .select('clientId')
    .lean();

  const results = [];
  for (const c of clients) {
    try {
      results.push(await reconcileClientInventory(c.clientId));
    } catch (err) {
      results.push({ clientId: c.clientId, error: err.message });
    }
  }
  return results;
}

module.exports = { reconcileClientInventory, runReconciliationForAllClients };
