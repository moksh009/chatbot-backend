'use strict';

const express = require('express');
const moment = require('moment');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const Order = require('../models/Order');
const ShopifyProduct = require('../models/ShopifyProduct');
const PixelEvent = require('../models/PixelEvent');
const { buildTrackingHealth } = require('../utils/commerce/trackingHealth');
const { hasScopeEffective } = require('../utils/shopify/shopifyScopeUtils');

function relTime(date) {
  if (!date) return null;
  return moment(date).fromNow();
}

function staleDays(date, thresholdDays = 7) {
  if (!date) return true;
  return moment().diff(moment(date), 'days') >= thresholdDays;
}

router.get('/:clientId/health', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user?.clientId && req.user.clientId !== clientId && req.user?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const client = await Client.findOne({ clientId })
      .select(
        'clientId businessName shopDomain shopifyConnectionStatus shopifyAccessToken shopifyScopes catalogSyncedAt customersSyncedAt meta.lastSync'
      )
      .lean();

    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const shopifyConnected = !!(client.shopifyAccessToken && client.shopDomain);
    const [lastOrder, lastProduct, orderCount, tracking] = await Promise.all([
      Order.findOne({ clientId }).sort({ createdAt: -1 }).select('createdAt').lean(),
      ShopifyProduct.findOne({ clientId }).sort({ lastSyncedAt: -1 }).select('lastSyncedAt').lean(),
      Order.countDocuments({ clientId }),
      shopifyConnected ? buildTrackingHealth(clientId, 1) : Promise.resolve(null),
    ]);

    const lastPixel = await PixelEvent.findOne({ clientId })
      .sort({ timestamp: -1 })
      .select('timestamp eventName')
      .lean();

    const pixelRecent =
      lastPixel && moment(lastPixel.timestamp).isAfter(moment().subtract(24, 'hours'));
    const pixelLive =
      lastPixel && moment(lastPixel.timestamp).isAfter(moment().subtract(15, 'minutes'));

    let pixelState = 'not_installed';
    if (pixelLive) pixelState = 'live';
    else if (pixelRecent || tracking?.storefrontActive) pixelState = 'quiet';
    else if (tracking?.storefrontActive) pixelState = 'quiet';

    const ordersSyncedAt = lastOrder?.createdAt || null;
    const productsSyncedAt = lastProduct?.lastSyncedAt || null;

    res.json({
      success: true,
      data: {
        shopify: {
          connected: shopifyConnected,
          shop: client.shopDomain || null,
          status: client.shopifyConnectionStatus || null,
        },
        orders: {
          count: orderCount,
          lastAt: ordersSyncedAt,
          lastLabel: relTime(ordersSyncedAt),
          stale: orderCount === 0 || staleDays(ordersSyncedAt, 14),
          never: orderCount === 0,
        },
        products: {
          lastAt: productsSyncedAt || client.catalogSyncedAt || null,
          lastLabel: relTime(productsSyncedAt || client.catalogSyncedAt),
          stale: staleDays(productsSyncedAt || client.catalogSyncedAt, 7),
        },
        scopes: {
          raw: client.shopifyScopes || '',
          hasInventoryLocations: hasScopeEffective(client.shopifyScopes, 'read_locations'),
          hasWriteInventory: hasScopeEffective(client.shopifyScopes, 'write_inventory'),
          canEditInventory:
            hasScopeEffective(client.shopifyScopes, 'write_inventory') &&
            hasScopeEffective(client.shopifyScopes, 'read_locations'),
        },
        pixel: {
          state: pixelState,
          lastEventAt: lastPixel?.timestamp || null,
          lastLabel: relTime(lastPixel?.timestamp),
          themeActive: !!tracking?.storefrontActive,
        },
        customers: {
          lastAt: client.customersSyncedAt || null,
          lastLabel: relTime(client.customersSyncedAt),
          stale: staleDays(client.customersSyncedAt, 14),
        },
        webhooks: {
          status: shopifyConnected ? 'ok' : 'unknown',
          label: shopifyConnected ? 'Assumed healthy' : 'Connect Shopify',
        },
        refreshedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
