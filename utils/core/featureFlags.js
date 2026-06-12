'use strict';

const Client = require('../../models/Client');

/** Canonical feature keys used by requireFeature() middleware */
const FEATURE_KEYS = {
  warranty: 'enableWarranty',
  abandonedCart: 'enableAbandonedCart',
  codToPrepaid: 'enableCodToPrepaid',
};

/**
 * Product rollout env toggles (global — not per-tenant wizard flags).
 * @see docs/internal/SMART-RULES-ENGINE-PAUSED.md
 * @see docs/internal/WEBSITE-CHAT-WIDGET-PAUSED.md
 */
function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return !['false', '0', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

const SMART_RULES_ENGINE_ENABLED = envFlag('SMART_RULES_ENGINE_ENABLED', false);
const WEBSITE_CHAT_WIDGET_SETTINGS_ENABLED = envFlag('WEBSITE_CHAT_WIDGET_SETTINGS_ENABLED', false);
const DELIVERY_RTO_INSIGHTS_ENABLED = envFlag('DELIVERY_RTO_INSIGHTS_ENABLED', false);

function isSmartRulesEngineEnabled() {
  return SMART_RULES_ENGINE_ENABLED;
}

function isWebsiteChatWidgetSettingsEnabled() {
  return WEBSITE_CHAT_WIDGET_SETTINGS_ENABLED;
}

function isDeliveryRtoInsightsEnabled() {
  return DELIVERY_RTO_INSIGHTS_ENABLED;
}

function wizardFeatures(client) {
  if (!client) return {};
  const wf = client.wizardFeatures;
  if (wf && typeof wf.toObject === 'function') return wf.toObject();
  return wf && typeof wf === 'object' ? wf : {};
}

function onboardingFeatures(client) {
  const od = client?.onboardingData?.features;
  return od && typeof od === 'object' ? od : {};
}

/**
 * Read feature state from an already-loaded client document.
 */
function readFeatureFromClient(client, featureName) {
  if (!client) return false;
  const wf = wizardFeatures(client);
  const od = onboardingFeatures(client);
  switch (featureName) {
    case 'warranty':
      return (
        wf.enableWarranty === true ||
        wf.warranty?.enabled === true ||
        od.enableWarranty === true
      );
    case 'abandonedCart':
      return (
        wf.enableAbandonedCart !== false &&
        od.enableAbandonedCart !== false &&
        client.settings?.abandonedCartEnabled !== false
      );
    case 'codToPrepaid':
      return wf.enableCodToPrepaid === true || od.enableCodToPrepaid === true;
    default:
      return false;
  }
}

/**
 * Single source of truth — always reads fresh from DB for gates.
 */
async function isFeatureEnabled(clientId, featureName) {
  if (!clientId || !featureName) return false;
  const client = await Client.findOne({ clientId })
    .select('wizardFeatures onboardingData settings brand')
    .lean();
  return readFeatureFromClient(client, featureName);
}

async function loadClientFeatureFlags(clientId) {
  const client = await Client.findOne({ clientId })
    .select('wizardFeatures onboardingData settings')
    .lean();
  if (!client) return null;
  return {
    warranty: readFeatureFromClient(client, 'warranty'),
    abandonedCart: readFeatureFromClient(client, 'abandonedCart'),
    codToPrepaid: readFeatureFromClient(client, 'codToPrepaid'),
  };
}

/**
 * Express middleware — blocks API when feature is off for this workspace.
 */
function requireFeature(featureName) {
  return async (req, res, next) => {
    try {
      const { tenantClientId } = require('./queryHelpers');
      const clientId =
        tenantClientId(req) ||
        req.params?.clientId ||
        req.query?.clientId ||
        req.body?.clientId;
      if (!clientId) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized',
          code: 'FEATURE_DISABLED',
        });
      }
      const enabled = await isFeatureEnabled(clientId, featureName);
      if (!enabled) {
        return res.status(403).json({
          success: false,
          error: `${featureName} is not enabled for this workspace`,
          code: 'FEATURE_DISABLED',
        });
      }
      next();
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  };
}

// Backward-compatible helpers
function isWarrantyEnabled(client) {
  return readFeatureFromClient(client, 'warranty');
}

function isAbandonedCartEnabled(client) {
  return readFeatureFromClient(client, 'abandonedCart');
}

module.exports = {
  FEATURE_KEYS,
  SMART_RULES_ENGINE_ENABLED,
  WEBSITE_CHAT_WIDGET_SETTINGS_ENABLED,
  wizardFeatures,
  readFeatureFromClient,
  isFeatureEnabled,
  loadClientFeatureFlags,
  requireFeature,
  isWarrantyEnabled,
  isAbandonedCartEnabled,
  isSmartRulesEngineEnabled,
  isWebsiteChatWidgetSettingsEnabled,
  isDeliveryRtoInsightsEnabled,
};
