'use strict';

const Client = require('../../models/Client');
const AmazonInventorySnapshot = require('../../models/AmazonInventorySnapshot');
const SkuMapping = require('../../models/SkuMapping');
const InventoryLedger = require('../../models/InventoryLedger');
const AmazonSPAPI = require('../commerce/amazonSPAPI');
const { parseFbaSummaryRow } = AmazonSPAPI;
const { decrypt } = require('../core/encryption');
const { acquireAmazonToken, withAmazonRetry } = require('./amazonRateLimiter');
const { auditLog } = require('../../services/audit/auditWriter');
const log = require('../core/logger')('AmazonInventorySync');

function buildAmazonApi(client) {
  return new AmazonSPAPI({
    refreshToken: decrypt(client.amazonConfig.refreshToken),
    clientId: client.amazonConfig.lwaClientId || process.env.AMAZON_CLIENT_ID,
    clientSecret: client.amazonConfig.lwaClientSecret
      ? decrypt(client.amazonConfig.lwaClientSecret)
      : process.env.AMAZON_CLIENT_SECRET,
    region: client.amazonConfig.region || 'eu-west-1',
  });
}

function computeTotalSellable(fba, merchantFulfilled) {
  const fbaSellable = Number(fba?.fulfillable) || 0;
  const mf =
    merchantFulfilled?.quantity != null ? Number(merchantFulfilled.quantity) : null;
  if (mf != null) return fbaSellable + Math.max(0, mf);
  return fbaSellable;
}

async function upsertSnapshot(clientId, marketplaceId, row, { lastSyncSource = 'cron' }) {
  const totalSellable = computeTotalSellable(row.fba, row.merchantFulfilled);
  return AmazonInventorySnapshot.findOneAndUpdate(
    { clientId, sellerSku: row.sellerSku, marketplaceId },
    {
      $set: {
        asin: row.asin || '',
        fba: row.fba,
        merchantFulfilled: row.merchantFulfilled || { quantity: null },
        totalSellable,
        lastSyncedAt: new Date(),
        lastSyncSource,
        lastSyncError: '',
      },
    },
    { upsert: true, new: true }
  );
}

async function syncMerchantListing(api, client, marketplaceId, sellerSku, snapshotRow) {
  await acquireAmazonToken(client.clientId);
  const details = await withAmazonRetry(() =>
    api.getListingDetails({
      sellerId: client.amazonConfig.sellerId,
      marketplaceId,
      sellerSku,
    })
  );

  if (!details?.ok) {
    return { sellerSku, merchantError: details?.error || 'listing_fetch_failed' };
  }

  snapshotRow.merchantFulfilled = {
    quantity: details.merchantFulfilled?.quantity ?? 0,
    lastSyncedAt: new Date(),
    fulfillmentChannels: details.merchantFulfilled?.channels || [],
  };
  if (details.asin) snapshotRow.asin = details.asin;

  const mapping = await SkuMapping.findOne({ clientId: client.clientId, 'amazon.sellerSku': sellerSku });
  if (mapping && details.detectedFulfillment && mapping.amazon?.fulfillment !== details.detectedFulfillment) {
    await SkuMapping.updateOne(
      { clientId: client.clientId, internalSku: mapping.internalSku },
      { $set: { 'amazon.fulfillment': details.detectedFulfillment } }
    );
  }

  return { sellerSku, fulfillment: details.detectedFulfillment };
}

async function updateLedgerAmazonFields(clientId, internalSku, snapshot) {
  await InventoryLedger.findOneAndUpdate(
    { clientId, sku: internalSku, locationId: 'default' },
    {
      $set: {
        lastAmazonSync: {
          at: snapshot.lastSyncedAt,
          qty: snapshot.totalSellable,
          fbaFulfillable: snapshot.fba?.fulfillable ?? 0,
          merchantFulfilled: snapshot.merchantFulfilled?.quantity,
        },
      },
    },
    { upsert: false }
  );
}

/**
 * Pull FBA + merchant-fulfilled inventory for a tenant.
 * @param {string} clientId
 * @param {{ sellerSku?: string, lastSyncSource?: string }} opts
 */
async function syncAmazonInventoryForClient(clientId, opts = {}) {
  const started = Date.now();
  const client = await Client.findOne({ clientId }).lean();
  if (!client?.amazonConfig?.refreshToken || !client.amazonConfig.sellerId) {
    return { skipped: true, reason: 'amazon_not_connected' };
  }

  const marketplaceId = client.amazonConfig.marketplaceId || 'A21TJ7DG3Y56XX';
  const api = buildAmazonApi(client);
  const errors = [];
  let synced = 0;
  let fbaPages = 0;

  const mappings = await SkuMapping.find({
    clientId,
    'amazon.sellerSku': { $exists: true, $ne: '' },
  }).lean();

  const targetSkus = opts.sellerSku
    ? mappings.filter((m) => m.amazon.sellerSku === opts.sellerSku)
    : mappings;

  const mfMappings = targetSkus.filter((m) =>
    ['merchant', 'mixed'].includes(m.amazon?.fulfillment || 'merchant')
  );

  try {
    if (!opts.sellerSku) {
      let nextToken = null;
      do {
        await acquireAmazonToken(clientId);
        const page = await withAmazonRetry(() =>
          api.getFbaInventorySummaries({ marketplaceId, nextToken })
        );
        fbaPages += 1;
        for (const raw of page.summaries || []) {
          const parsed = parseFbaSummaryRow(raw);
          if (!parsed.sellerSku) continue;

          const mapping = mappings.find((m) => m.amazon.sellerSku === parsed.sellerSku);
          if (mapping && ['merchant', 'mixed'].includes(mapping.amazon?.fulfillment || '')) {
            try {
              await syncMerchantListing(api, client, marketplaceId, parsed.sellerSku, parsed);
            } catch (e) {
              errors.push({ sellerSku: parsed.sellerSku, error: e.message });
            }
          }

          const snap = await upsertSnapshot(clientId, marketplaceId, parsed, {
            lastSyncSource: opts.lastSyncSource || 'cron',
          });
          if (mapping) await updateLedgerAmazonFields(clientId, mapping.internalSku, snap);
          synced += 1;
        }
        nextToken = page.nextToken;
      } while (nextToken);
    } else {
      const sellerSku = opts.sellerSku;
      let parsed = {
        sellerSku,
        asin: '',
        fba: {
          fulfillable: 0,
          inbound: { working: 0, shipped: 0, receiving: 0 },
          reserved: 0,
          unfulfillable: 0,
          researching: 0,
          totalQuantity: 0,
        },
        merchantFulfilled: null,
      };

      try {
        await acquireAmazonToken(clientId);
        const page = await withAmazonRetry(() =>
          api.getFbaInventorySummaries({ marketplaceId, sellerSkus: [sellerSku] })
        );
        if (page.summaries?.[0]) parsed = parseFbaSummaryRow(page.summaries[0]);
      } catch (e) {
        if (!e.isRateLimit && e.status !== 404) errors.push({ sellerSku, error: e.message });
      }

      const mapping = mappings.find((m) => m.amazon.sellerSku === sellerSku);
      if (
        !mapping ||
        ['merchant', 'mixed'].includes(mapping.amazon?.fulfillment || 'merchant')
      ) {
        try {
          await syncMerchantListing(api, client, marketplaceId, sellerSku, parsed);
        } catch (e) {
          errors.push({ sellerSku, error: e.message });
        }
      }

      const snap = await upsertSnapshot(clientId, marketplaceId, parsed, {
        lastSyncSource: opts.lastSyncSource || 'manual_refresh',
      });
      if (mapping) await updateLedgerAmazonFields(clientId, mapping.internalSku, snap);
      synced += 1;
    }

    for (const m of mfMappings) {
      if (opts.sellerSku && m.amazon.sellerSku !== opts.sellerSku) continue;
      const existing = await AmazonInventorySnapshot.findOne({
        clientId,
        sellerSku: m.amazon.sellerSku,
        marketplaceId,
      }).lean();

      const row = {
        sellerSku: m.amazon.sellerSku,
        asin: existing?.asin || m.amazon.asin || '',
        fba: existing?.fba || {
          fulfillable: 0,
          inbound: { working: 0, shipped: 0, receiving: 0 },
          reserved: 0,
          unfulfillable: 0,
          researching: 0,
          totalQuantity: 0,
        },
        merchantFulfilled: existing?.merchantFulfilled,
      };

      if (m.amazon.fulfillment === 'merchant' && !row.fba?.fulfillable) {
        /* merchant-only may have no FBA row */
      }

      try {
        await syncMerchantListing(api, client, marketplaceId, m.amazon.sellerSku, row);
        const snap = await upsertSnapshot(clientId, marketplaceId, row, {
          lastSyncSource: opts.lastSyncSource || 'cron',
        });
        await updateLedgerAmazonFields(clientId, m.internalSku, snap);
        if (!opts.sellerSku) synced += 1;
      } catch (e) {
        errors.push({ sellerSku: m.amazon.sellerSku, error: e.message });
        await AmazonInventorySnapshot.updateOne(
          { clientId, sellerSku: m.amazon.sellerSku, marketplaceId },
          { $set: { lastSyncError: e.message, lastSyncedAt: new Date() } }
        );
      }
    }

    await Client.updateOne(
      { clientId },
      { $set: { 'amazonConfig.lastInventoryPullAt': new Date() } }
    );

    auditLog({
      category: 'inventory',
      action: 'inventory.amazon_inventory_pull',
      clientId,
      details: { synced, errors: errors.length, durationMs: Date.now() - started, fbaPages },
    }).catch(() => {});

    return {
      clientId,
      synced,
      errors,
      durationMs: Date.now() - started,
      fbaPages,
    };
  } finally {
    api.clearAccessToken();
  }
}

async function enqueueAmazonPullForAllClients() {
  const clients = await Client.find({
    'amazonConfig.refreshToken': { $exists: true, $ne: '' },
    'amazonConfig.sellerId': { $exists: true, $ne: '' },
    isActive: true,
  })
    .select('clientId')
    .lean();

  const { queueAmazonInventoryPull } = require('../utils/messaging/queues/amazonInventoryPullQueue');
  const results = [];
  for (const c of clients) {
    try {
      await queueAmazonInventoryPull({ clientId: c.clientId });
      results.push({ clientId: c.clientId, queued: true });
    } catch (e) {
      results.push({ clientId: c.clientId, error: e.message });
    }
  }
  return results;
}

module.exports = {
  syncAmazonInventoryForClient,
  enqueueAmazonPullForAllClients,
  computeTotalSellable,
};
