'use strict';

const Client = require('../../models/Client');
const InventoryAdjustment = require('../../models/InventoryAdjustment');
const { withShopifyRetry } = require('../shopify/shopifyHelper');
const log = require('../core/logger')('InventoryShopifyPush');

async function pushInventoryToShopifyInline({
  clientId,
  sku,
  available,
  inventoryItemId,
  locationId = 'default',
  adjustmentId,
}) {
  const client = await Client.findOne({ clientId }).select('shopDomain shopifyAccessToken').lean();
  if (!client?.shopifyAccessToken) {
    throw new Error('Shopify not connected');
  }

  let itemId = inventoryItemId;
  if (!itemId) {
    const ShopifyProduct = require('../../models/ShopifyProduct');
    const row = await ShopifyProduct.findOne({ clientId, sku }).select('shopifyInventoryItemId').lean();
    itemId = row?.shopifyInventoryItemId;
  }
  if (!itemId) {
    log.warn(`No inventory_item_id for ${clientId}/${sku}`);
    if (adjustmentId) {
      await InventoryAdjustment.updateOne({ _id: adjustmentId }, { $set: { syncStatus: 'failed' } });
    }
    return { ok: false, reason: 'missing_inventory_item_id' };
  }

  const locId = locationId === 'default' ? null : locationId;

  try {
    const { bulkSetInventoryQuantities } = require('./shopifyInventoryGraphQL');
    await bulkSetInventoryQuantities(clientId, [
      { inventoryItemId: itemId, quantity: available, locationId: locId },
    ]);
  } catch (gqlErr) {
    await withShopifyRetry(clientId, async (shop) => {
      let location_id = locId;
      if (!location_id) {
        const locRes = await shop.get('/locations.json?limit=1');
        location_id = locRes.data?.locations?.[0]?.id;
      }
      if (!location_id) throw new Error('No Shopify location');

      await shop.post('/inventory_levels/set.json', {
        location_id,
        inventory_item_id: itemId,
        available: Math.max(0, Number(available) || 0),
      });
    });
  }

  if (adjustmentId) {
    await InventoryAdjustment.updateOne({ _id: adjustmentId }, { $set: { syncStatus: 'synced' } });
  }

  return { ok: true };
}

module.exports = { pushInventoryToShopifyInline };
