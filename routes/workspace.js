'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { verifyTenantScope } = require('../middleware/verifyTenantScope');
const { buildConnectionStatusPayload } = require('../utils/core/connectionStatus');
const { buildConnectionStatusContract } = require('../utils/core/connectionStatusV2');
const { getCachedClient, CONNECTION_STATUS_SELECT, invalidateClientCache } = require('../utils/core/clientCache');
const {
  isSmartRulesEngineEnabled,
  isWebsiteChatWidgetSettingsEnabled,
  isDeliveryRtoInsightsEnabled,
} = require('../utils/core/featureFlags');
const { getAppRedis, isRedisReady } = require('../utils/core/redisFactory');

const CACHE_TTL_SEC = 30;

function cacheKey(clientId) {
  return `workspace:connection:${clientId}`;
}

/**
 * GET /api/workspace/:clientId/connection-status
 * Canonical connection contract (Phase 4). ?refresh=1 bypasses cache.
 */
router.get('/:clientId/connection-status', protect, verifyTenantScope(), async (req, res) => {
  const { clientId } = req.params;
  const forceRefresh = req.query.refresh === '1' || req.query.force === '1';

  let client = await getCachedClient(clientId, CONNECTION_STATUS_SELECT);

  // Heal false "expired" states for embedded Shopify installs (expiring offline tokens + refresh)
  if (client?.shopDomain && client?.shopifyAccessToken) {
    const shopifySt = String(client.shopifyConnectionStatus || '').toLowerCase();
    const shouldHeal =
      forceRefresh ||
      shopifySt === 'error' ||
      (client.shopifyTokenExpiresAt &&
        new Date(client.shopifyTokenExpiresAt).getTime() - Date.now() < 30 * 60 * 1000);
    if (shouldHeal) {
      try {
        const { reconcileShopifyConnection } = require('../utils/shopify/shopifyConnectionHeal');
        await reconcileShopifyConnection(clientId, { tryRefresh: true });
        invalidateClientCache(clientId);
        client = await getCachedClient(clientId, CONNECTION_STATUS_SELECT);
      } catch (healErr) {
        console.warn('[workspace] shopify heal:', healErr.message);
      }
    }
  }

  const contract = await buildConnectionStatusContract(client);
  const legacy = contract._legacy || buildConnectionStatusPayload(client);
  delete contract._legacy;

  let workerHealth = null;
  try {
    const { buildWorkerHealthSnapshot } = require('../utils/hub/workerHealth');
    workerHealth = await buildWorkerHealthSnapshot();
  } catch (workerErr) {
    console.warn('[workspace] workerHealth:', workerErr.message);
    workerHealth = { workerHealthy: false, error: workerErr.message };
  }

  if (client?.shopifyAccessToken && client?.shopDomain) {
    try {
      const { getPixelWebhookSecret, ensurePixelWebhookSecret } = require('../utils/commerce/pixelWebhookSecret');
      const pixelSecret = await getPixelWebhookSecret(clientId);
      if (!pixelSecret) await ensurePixelWebhookSecret(clientId);
    } catch (pixelErr) {
      console.warn('[workspace] pixelWebhookSecret backfill:', pixelErr.message);
    }
  }

  const payload = {
    ...contract,
    shopify_connected: legacy.shopify_connected,
    whatsapp_connected: legacy.whatsapp_connected,
    meta_connected: legacy.meta_connected,
    instagram_connected: legacy.instagram_connected,
    workerHealth,
    featureRollout: {
      smartRulesEngine: isSmartRulesEngineEnabled(),
      websiteChatWidgetSettings: isWebsiteChatWidgetSettingsEnabled(),
      deliveryRtoInsights: isDeliveryRtoInsightsEnabled(),
    },
  };

  try {
    const redis = getAppRedis();
    if (redis && isRedisReady(redis) && !forceRefresh) {
      try {
        const cached = await redis.get(cacheKey(clientId));
        if (cached) {
          const parsed = JSON.parse(cached);
          return res.json({ success: true, clientId, cached: true, ...parsed });
        }
      } catch (cacheReadErr) {
        console.warn('[workspace] connection-status cache read:', cacheReadErr.message);
      }
    }

    if (redis && isRedisReady(redis)) {
      try {
        await redis.setex(cacheKey(clientId), CACHE_TTL_SEC, JSON.stringify(payload));
      } catch (cacheWriteErr) {
        console.warn('[workspace] connection-status cache write:', cacheWriteErr.message);
      }
    }

    return res.json({ success: true, clientId, cached: false, ...payload });
  } catch (err) {
    console.warn('[workspace] connection-status:', err.message);
    return res.json({ success: true, clientId, cached: false, ...payload });
  }
});

router.post('/:clientId/connection-status/invalidate', protect, verifyTenantScope(), async (req, res) => {
  const { clientId } = req.params;
  invalidateClientCache(clientId);
  const redis = getAppRedis();
  if (redis) await redis.del(cacheKey(clientId));
  return res.json({ success: true });
});

router.get('/:clientId/logistics/profile', protect, verifyTenantScope(), async (req, res) => {
  try {
    const { getLogisticsProfile } = require('../services/logisticsEligibilityService');
    const profile = await getLogisticsProfile(req.params.clientId);
    return res.json({ success: true, profile });
  } catch (err) {
    return res.status(err.message === 'Client not found' ? 404 : 500).json({
      success: false,
      error: err.message,
    });
  }
});

router.patch('/:clientId/logistics/settings', protect, verifyTenantScope(), async (req, res) => {
  try {
    const { updateLogisticsSettings } = require('../services/logisticsEligibilityService');
    const profile = await updateLogisticsSettings(req.params.clientId, req.body || {});
    const { invalidateClientCache } = require('../utils/core/clientCache');
    await invalidateClientCache(req.params.clientId);
    return res.json({ success: true, profile });
  } catch (err) {
    return res.status(err.message === 'Client not found' ? 404 : 500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;
