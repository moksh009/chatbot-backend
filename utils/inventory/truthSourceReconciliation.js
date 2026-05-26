'use strict';

const SkuMapping = require('../../models/SkuMapping');
const Client = require('../../models/Client');
const { applyAdjustment } = require('./ledger');
const { getChannelInventoryView } = require('./channelDrift');
const { auditLog } = require('../../services/audit/auditWriter');

function authoritativeQty(view, truthSource) {
  switch (truthSource) {
    case 'shopify':
      return view.shopify?.qty != null ? Number(view.shopify.qty) : null;
    case 'amazon_fba':
      return view.amazon?.fba?.fulfillable != null ? Number(view.amazon.fba.fulfillable) : null;
    case 'amazon_combined':
      return view.amazon?.totalSellable != null ? Number(view.amazon.totalSellable) : null;
    case 'ledger':
    default:
      return view.ledger != null ? Number(view.ledger) : null;
  }
}

/**
 * Reconcile ledger to configured truthSource per SKU.
 */
async function reconcileByTruthSource(clientId) {
  const client = await Client.findOne({ clientId }).select('inventoryConfig').lean();
  const defaultTruth = client?.inventoryConfig?.defaultTruthSource || 'ledger';

  const mappings = await SkuMapping.find({ clientId }).lean();
  const corrections = [];

  for (const m of mappings) {
    const truthSource = m.truthSource || defaultTruth;
    if (truthSource === 'ledger') continue;

    const view = await getChannelInventoryView(clientId, m.internalSku);
    const target = authoritativeQty(view, truthSource);
    if (target == null) continue;

    const ledgerQty = Number(view.ledger) || 0;
    const delta = target - ledgerQty;
    if (delta === 0) continue;

    const reason =
      truthSource === 'shopify'
        ? 'correction'
        : 'reconciliation';

    await applyAdjustment({
      clientId,
      sku: m.internalSku,
      delta,
      reason,
      source: 'amazon_inventory_pull',
      sourceRef: `truth:${truthSource}:${new Date().toISOString().slice(0, 10)}`,
      idempotencyKey: `truth:${clientId}:${m.internalSku}:${truthSource}:${target}`,
      skipShopifyPush: truthSource.startsWith('amazon'),
    });

    corrections.push({ sku: m.internalSku, truthSource, ledgerQty, target, delta });
  }

  if (corrections.length) {
    auditLog({
      category: 'inventory',
      action: 'inventory.truth_source_reconciliation',
      clientId,
      details: { corrections: corrections.slice(0, 20) },
    }).catch(() => {});
  }

  return { clientId, corrections };
}

module.exports = { reconcileByTruthSource, authoritativeQty };
