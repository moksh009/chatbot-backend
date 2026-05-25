'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { verifyTenantScope } = require('../middleware/verifyTenantScope');
const { buildConnectionStatusPayload } = require('../utils/core/connectionStatus');
const { buildConnectionStatusContract } = require('../utils/core/connectionStatusV2');
const { getCachedClient, CONNECTION_STATUS_SELECT, invalidateClientCache } = require('../utils/core/clientCache');
const { getAppRedis } = require('../utils/core/redisFactory');

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

  try {
    const redis = getAppRedis();
    if (redis && !forceRefresh) {
      const cached = await redis.get(cacheKey(clientId));
      if (cached) {
        const parsed = JSON.parse(cached);
        return res.json({ success: true, clientId, cached: true, ...parsed });
      }
    }

    const client = await getCachedClient(clientId, CONNECTION_STATUS_SELECT);
    const contract = await buildConnectionStatusContract(client);
    const legacy = contract._legacy || buildConnectionStatusPayload(client);
    delete contract._legacy;

    const payload = {
      ...contract,
      shopify_connected: legacy.shopify_connected,
      whatsapp_connected: legacy.whatsapp_connected,
      meta_connected: legacy.meta_connected,
      instagram_connected: legacy.instagram_connected,
    };

    if (redis) {
      await redis.setex(cacheKey(clientId), CACHE_TTL_SEC, JSON.stringify(payload));
    }

    return res.json({ success: true, clientId, cached: false, ...payload });
  } catch (err) {
    console.warn('[workspace] connection-status:', err.message);
    return res.json({
      success: true,
      clientId,
      shopify_connected: false,
      whatsapp_connected: false,
      meta_connected: false,
      instagram_connected: false,
      overall: { readyForBot: false, readyForCampaigns: false, readyForCommerce: false },
    });
  }
});

router.post('/:clientId/connection-status/invalidate', protect, verifyTenantScope(), async (req, res) => {
  const { clientId } = req.params;
  invalidateClientCache(clientId);
  const redis = getAppRedis();
  if (redis) await redis.del(cacheKey(clientId));
  return res.json({ success: true });
});

module.exports = router;
