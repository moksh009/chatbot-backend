'use strict';

const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const Notification = require('../models/Notification');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { verifyTenantScope } = require('../middleware/verifyTenantScope');
const { apiCache } = require('../middleware/apiCache');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { buildConnectionStatusPayload } = require('../utils/core/connectionStatus');
const { buildConnectionStatusContract, applyLiveProbesToContract } = require('../utils/core/connectionStatusV2');
const { getCachedClient, CONNECTION_STATUS_SELECT, invalidateClientCache } = require('../utils/core/clientCache');
const {
  readFullCache,
  readFlagsCache,
  writeFullCache,
  writeFlagsCache,
  invalidateWorkspaceConnectionCache,
  stripVolatileConnectionLayers,
} = require('../utils/core/workspaceConnectionCache');
const {
  isSmartRulesEngineEnabled,
  isWebsiteChatWidgetSettingsEnabled,
  isDeliveryRtoInsightsEnabled,
} = require('../utils/core/featureFlags');

async function fetchWorkerHealthSnapshot() {
  try {
    const { buildWorkerHealthSnapshot } = require('../utils/hub/workerHealth');
    return await buildWorkerHealthSnapshot();
  } catch (workerErr) {
    console.warn('[workspace] workerHealth:', workerErr.message);
    return { workerHealthy: false, error: workerErr.message };
  }
}

/**
 * Merge cached flags (5m) with fresh probes (30s) + worker health.
 */
async function buildFromFlagsCache(clientId, flagsCached) {
  const client = await getCachedClient(clientId, CONNECTION_STATUS_SELECT);
  const merged = { ...flagsCached };
  if (client) {
    await applyLiveProbesToContract(client, merged);
  }
  merged.workerHealth = await fetchWorkerHealthSnapshot();
  return merged;
}

function buildFeatureRollout() {
  return {
    smartRulesEngine: isSmartRulesEngineEnabled(),
    websiteChatWidgetSettings: isWebsiteChatWidgetSettingsEnabled(),
    deliveryRtoInsights: isDeliveryRtoInsightsEnabled(),
  };
}

/**
 * Shared connection-status payload (connection-status route + workspace shell).
 */
async function buildWorkspaceConnectionPayload(clientId, { forceRefresh = false } = {}) {
  let client = await getCachedClient(clientId, CONNECTION_STATUS_SELECT);

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
    workerHealth = await fetchWorkerHealthSnapshot();
  } catch (workerErr) {
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

  const featureRollout = buildFeatureRollout();

  return {
    ...contract,
    shopify_connected: legacy.shopify_connected,
    whatsapp_connected: legacy.whatsapp_connected,
    meta_connected: legacy.meta_connected,
    instagram_connected: legacy.instagram_connected,
    workerHealth,
    featureRollout,
  };
}

async function fetchUnreadNotificationCount(clientId) {
  return Notification.countDocuments({ clientId, status: 'unread' });
}

async function fetchRecentActivities(clientId, limit = 3) {
  return ActivityLog.find({ clientId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

async function fetchCustomVariables(clientId) {
  const client = await Client.findOne({ clientId }).select('customVariables').lean();
  return client?.customVariables || [];
}

/**
 * GET /api/workspace/:clientId/shell
 * Cold-start bundle: connection + notification count + pulse preview + custom variables.
 * Gate: FEATURE_WORKSPACE_SHELL=true (frontend: VITE_FEATURE_WORKSPACE_SHELL)
 */
router.get('/:clientId/shell', protect, verifyTenantScope(), apiCache(30), async (req, res) => {
  if (process.env.FEATURE_WORKSPACE_SHELL !== 'true') {
    return res.status(404).json({ success: false, error: 'Workspace shell not enabled' });
  }

  const clientId = tenantClientId(req);
  if (!clientId || clientId !== req.params.clientId) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  const sections = ['connection', 'notifications', 'pulse', 'customVariables'];
  const [connResult, notifResult, activitiesResult, variablesResult] = await Promise.allSettled([
    buildWorkspaceConnectionPayload(clientId, { forceRefresh: false }),
    fetchUnreadNotificationCount(clientId),
    fetchRecentActivities(clientId, 3),
    fetchCustomVariables(clientId),
  ]);

  const failedSections = sections.filter((_, i) => {
    const results = [connResult, notifResult, activitiesResult, variablesResult];
    return results[i].status === 'rejected';
  });

  if (connResult.status === 'rejected') {
    console.warn('[workspace] shell connection:', connResult.reason?.message || connResult.reason);
  }
  if (notifResult.status === 'rejected') {
    console.warn('[workspace] shell notifications:', notifResult.reason?.message || notifResult.reason);
  }
  if (activitiesResult.status === 'rejected') {
    console.warn('[workspace] shell pulse:', activitiesResult.reason?.message || activitiesResult.reason);
  }
  if (variablesResult.status === 'rejected') {
    console.warn('[workspace] shell variables:', variablesResult.reason?.message || variablesResult.reason);
  }

  const connection = connResult.status === 'fulfilled' ? connResult.value : {};
  const featureRollout = connection.featureRollout || buildFeatureRollout();

  return res.json({
    success: true,
    clientId,
    connection,
    notifications: {
      unreadCount: notifResult.status === 'fulfilled' ? notifResult.value : 0,
    },
    pulse: {
      recentActivities: activitiesResult.status === 'fulfilled' ? activitiesResult.value : [],
    },
    customVariables: variablesResult.status === 'fulfilled' ? variablesResult.value : [],
    featureRollout,
    capabilities: featureRollout,
    meta: {
      partial: failedSections.length > 0,
      failedSections,
    },
  });
});

/**
 * GET /api/workspace/:clientId/connection-status
 * Canonical connection contract (Phase 4). ?refresh=1 bypasses cache.
 * Cache layers: full 30s | flags 5m + fresh probes 30s (Phase 4.1).
 */
router.get('/:clientId/connection-status', protect, verifyTenantScope(), async (req, res) => {
  const { clientId } = req.params;
  const forceRefresh = req.query.refresh === '1' || req.query.force === '1';

  try {
    if (!forceRefresh) {
      const fullCached = await readFullCache(clientId);
      if (fullCached) {
        return res.json({ success: true, clientId, cached: true, cacheLayer: 'full', ...fullCached });
      }

      const flagsCached = await readFlagsCache(clientId);
      if (flagsCached) {
        const merged = await buildFromFlagsCache(clientId, { ...flagsCached });
        await writeFullCache(clientId, merged);
        return res.json({
          success: true,
          clientId,
          cached: true,
          cacheLayer: 'flags+probes',
          ...merged,
        });
      }
    }

    const payload = await buildWorkspaceConnectionPayload(clientId, { forceRefresh });

    await Promise.all([
      writeFullCache(clientId, payload),
      writeFlagsCache(clientId, stripVolatileConnectionLayers(payload)),
    ]);

    return res.json({ success: true, clientId, cached: false, ...payload });
  } catch (err) {
    console.warn('[workspace] connection-status:', err.message);
    try {
      const payload = await buildWorkspaceConnectionPayload(clientId, { forceRefresh });
      return res.json({ success: true, clientId, cached: false, ...payload });
    } catch (innerErr) {
      return res.status(500).json({ success: false, message: innerErr.message });
    }
  }
});

router.post('/:clientId/connection-status/invalidate', protect, verifyTenantScope(), async (req, res) => {
  const { clientId } = req.params;
  invalidateClientCache(clientId);
  await invalidateWorkspaceConnectionCache(clientId);
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
