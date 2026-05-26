'use strict';

const express = require('express');
const router = express.Router();
const { protect, verifyClientAccess } = require('../middleware/auth');
const Client = require('../models/Client');
const AmazonSPAPI = require('../utils/commerce/amazonSPAPI');
const { encrypt } = require('../utils/core/encryption');

router.get('/:clientId/status', protect, verifyClientAccess, async (req, res) => {
  const client = await Client.findOne({ clientId: req.params.clientId })
    .select('amazonConfig')
    .lean();
  const cfg = client?.amazonConfig || {};
  res.json({
    success: true,
    connected: !!(cfg.refreshToken && cfg.sellerId),
    sellerId: cfg.sellerId || '',
    marketplaceId: cfg.marketplaceId || 'A21TJ7DG3Y56XX',
    needsReauth: !!cfg.needsReauth,
    lastSyncAt: cfg.lastSyncAt,
    lastTokenRefreshAt: cfg.lastTokenRefreshAt,
  });
});

router.post('/:clientId/connect', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const {
      sellerId,
      marketplaceId = 'A21TJ7DG3Y56XX',
      refreshToken,
      lwaClientId,
      lwaClientSecret,
      region = 'eu-west-1',
    } = req.body || {};

    if (!sellerId || !refreshToken) {
      return res.status(400).json({ success: false, error: 'sellerId and refreshToken required' });
    }

    const $set = {
      'amazonConfig.sellerId': sellerId,
      'amazonConfig.marketplaceId': marketplaceId,
      'amazonConfig.refreshToken': encrypt(refreshToken),
      'amazonConfig.region': region,
      'amazonConfig.connectedAt': new Date(),
      'amazonConfig.needsReauth': false,
    };
    if (lwaClientId) $set['amazonConfig.lwaClientId'] = lwaClientId;
    if (lwaClientSecret) $set['amazonConfig.lwaClientSecret'] = encrypt(lwaClientSecret);

    await Client.updateOne({ clientId }, { $set });
    res.json({ success: true, message: 'Amazon connection saved' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:clientId/test', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId }).lean();
    if (!client?.amazonConfig?.refreshToken) {
      return res.status(400).json({ success: false, error: 'Amazon not connected' });
    }
    const { decrypt } = require('../utils/core/encryption');
    const api = new AmazonSPAPI({
      refreshToken: decrypt(client.amazonConfig.refreshToken),
      clientId: client.amazonConfig.lwaClientId || process.env.AMAZON_CLIENT_ID,
      clientSecret: client.amazonConfig.lwaClientSecret
        ? decrypt(client.amazonConfig.lwaClientSecret)
        : process.env.AMAZON_CLIENT_SECRET,
      region: client.amazonConfig.region,
    });
    const orders = await api.getOrders(
      client.amazonConfig.marketplaceId || 'A21TJ7DG3Y56XX'
    );
    res.json({
      success: true,
      sampleOrderCount: orders.length,
      sampleOrderId: orders[0]?.AmazonOrderId || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:clientId/disconnect', protect, verifyClientAccess, async (req, res) => {
  await Client.updateOne(
    { clientId: req.params.clientId },
    {
      $set: {
        amazonConfig: {
          sellerId: '',
          marketplaceId: 'A21TJ7DG3Y56XX',
          refreshToken: '',
          needsReauth: false,
        },
      },
    }
  );
  res.json({ success: true });
});

router.post('/:clientId/sync-now', protect, verifyClientAccess, async (req, res) => {
  const client = await Client.findOne({ clientId: req.params.clientId }).lean();
  if (!client?.amazonConfig?.refreshToken) {
    return res.status(400).json({ success: false, error: 'Amazon not connected' });
  }
  res.json({ success: true, message: 'Sync runs on the 15-minute schedule; check orders shortly.' });
});

module.exports = router;
