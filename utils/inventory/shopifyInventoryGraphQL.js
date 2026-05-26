'use strict';

const { executeGraphQL } = require('../shopify/shopifyGraphQL');
const { getLocations } = require('../shopify/shopifyGraphQL');
const log = require('../core/logger')('ShopifyInventoryGraphQL');

/**
 * Batch set on-hand quantities via GraphQL (rate-limit friendly vs per-SKU REST).
 * @param {string} clientId
 * @param {Array<{ inventoryItemId: string, quantity: number, locationId?: string }>} items
 */
async function bulkSetInventoryQuantities(clientId, items) {
  if (!items?.length) return { ok: true, count: 0 };

  const locations = await getLocations(clientId);
  const defaultLocationGid = locations?.[0]?.id;
  if (!defaultLocationGid) {
    throw new Error('No Shopify location for inventory push');
  }

  const quantities = items
    .filter((i) => i.inventoryItemId)
    .map((i) => {
      const itemGid = String(i.inventoryItemId).startsWith('gid://')
        ? i.inventoryItemId
        : `gid://shopify/InventoryItem/${i.inventoryItemId}`;
      const locGid = i.locationId?.startsWith('gid://')
        ? i.locationId
        : i.locationId
          ? `gid://shopify/Location/${i.locationId}`
          : defaultLocationGid;
      return {
        inventoryItemId: itemGid,
        locationId: locGid,
        quantity: Math.max(0, Number(i.quantity) || 0),
      };
    });

  if (!quantities.length) return { ok: false, reason: 'no_valid_items' };

  const mutation = `
    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { createdAt }
        userErrors { field message }
      }
    }
  `;

  const input = {
    name: 'available',
    reason: 'correction',
    ignoreCompareQuantity: true,
    quantities,
  };

  const data = await executeGraphQL(clientId, mutation, { input });
  const errors = data?.inventorySetQuantities?.userErrors || [];
  if (errors.length) {
    log.warn(`GraphQL inventory errors: ${JSON.stringify(errors)}`);
    throw new Error(errors[0].message || 'inventorySetQuantities failed');
  }

  return { ok: true, count: quantities.length };
}

module.exports = { bulkSetInventoryQuantities };
