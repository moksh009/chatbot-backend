'use strict';

const crypto = require('crypto');
const Client = require('../models/Client');
const { encrypt } = require('../utils/core/encryption');
const {
  GRANULAR_STATUSES,
  SHOPIFY_DEFAULT_RELIABLE,
  ruleIdToShipmentStatus,
  shipmentStatusToRuleId,
  getPartnerDef,
  listPartnersForUi,
} = require('../constants/logisticsPartnerRegistry');

const DIRECT_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

function publicApiBase() {
  return (
    process.env.API_PUBLIC_BASE_URL ||
    process.env.PUBLIC_API_URL ||
    'https://api.topedgeai.com'
  ).replace(/\/$/, '');
}

function buildWebhookUrl(clientId, providerCode) {
  const cid = encodeURIComponent(String(clientId || '').trim());
  const provider = encodeURIComponent(String(providerCode || 'sr').trim());
  return `${publicApiBase()}/api/logistics/inbound/${cid}?provider=${provider}`;
}

function isDirectWebhookLive(health = {}) {
  if (health.directWebhookActive === true) return true;
  const last = health.directWebhookLastSeenAt
    ? new Date(health.directWebhookLastSeenAt).getTime()
    : 0;
  return last > 0 && Date.now() - last < DIRECT_RECENT_MS;
}

function normalizeHealth(client = {}) {
  const health = client.logisticsHealth || {};
  const observed = [...new Set(
    (health.observedShopifyStatuses || [])
      .map((s) => String(s).toLowerCase().trim())
      .filter(Boolean)
  )];
  return {
    shopifyPathActive: health.shopifyPathActive !== false,
    observedShopifyStatuses: observed,
    directWebhookActive: isDirectWebhookLive(health),
    directWebhookLastSeenAt: health.directWebhookLastSeenAt || null,
    lastHealthCheckAt: health.lastHealthCheckAt || null,
  };
}

function canEnableShipmentRule(clientLean, ruleId) {
  const status = ruleIdToShipmentStatus(ruleId);
  if (!status) return { allowed: true };

  const partner = getPartnerDef(clientLean?.logisticsPartner);
  const mode = clientLean?.logisticsMode || 'shopify_only';
  const health = normalizeHealth(clientLean);
  const observed = new Set(health.observedShopifyStatuses);
  const directLive = health.directWebhookActive;
  const planDeclared = !!clientLean?.logisticsIntegration?.planDeclared;

  if (directLive && partner.directWebhookStatuses.includes(status)) {
    return { allowed: true, path: 'direct_webhook' };
  }

  if (SHOPIFY_DEFAULT_RELIABLE.has(status) || observed.has(status)) {
    return { allowed: true, path: observed.has(status) ? 'shopify_observed' : 'shopify_default' };
  }

  if (!GRANULAR_STATUSES.has(status)) {
    return { allowed: true, path: 'shopify_default' };
  }

  const upgradeHint = partner.directPlanLabel || null;
  const settingsUrl = '/settings?tab=connections&section=logistics';

  if (mode === 'direct' || mode === 'hybrid') {
    if (!planDeclared && partner.directWebhookMinPlan) {
      return {
        allowed: false,
        code: 'LOGISTICS_PLAN_REQUIRED',
        message:
          `${partner.label} direct tracking requires ${partner.directPlanLabel || 'an eligible plan'}. Confirm your plan below, then paste the webhook URL.`,
        upgradeHint,
        suggestedMode: 'direct',
        settingsUrl,
      };
    }
    return {
      allowed: false,
      code: 'LOGISTICS_DIRECT_SETUP',
      message:
        `Paste the TopEdge webhook URL in ${partner.label} and wait for the first tracking event. Out for delivery and NDR need this direct connection — Shopify sync alone does not send them (default ${partner.label} mapper).`,
      upgradeHint,
      suggestedMode: 'direct',
      settingsUrl,
    };
  }

  return {
    allowed: false,
    code: 'LOGISTICS_GRANULAR_BLOCKED',
    message:
      `"${status.replace(/_/g, ' ')}" is not available on Shopify sync alone for most ${partner.label || 'shipping'} setups. Switch to Direct webhook mode in Settings (requires ${partner.directPlanLabel || 'partner API plan'}).`,
    upgradeHint,
    suggestedMode: 'direct',
    settingsUrl,
  };
}

function buildEligibilityMap(clientLean) {
  const blockedRules = {};
  const eligibleRules = [];
  for (const status of ['in_transit', 'out_for_delivery', 'delivered', 'attempted_delivery', 'failure']) {
    const ruleId = shipmentStatusToRuleId(status);
    const gate = canEnableShipmentRule(clientLean, ruleId);
    if (gate.allowed) eligibleRules.push(ruleId);
    else blockedRules[ruleId] = gate;
  }
  return { eligibleRules, blockedRules };
}

async function getLogisticsProfile(clientId) {
  const client = await Client.findOne({ clientId })
    .select(
      'clientId logisticsPartner logisticsMode logisticsIntegration logisticsHealth shopDomain shopifyAccessToken'
    )
    .lean();
  if (!client) throw new Error('Client not found');

  const partner = getPartnerDef(client.logisticsPartner);
  const health = normalizeHealth(client);
  const { eligibleRules, blockedRules } = buildEligibilityMap(client);

  let webhookSecret = client.logisticsIntegration?.webhookSecret || '';
  if ((client.logisticsMode === 'direct' || client.logisticsMode === 'hybrid') && !webhookSecret) {
    webhookSecret = crypto.randomBytes(18).toString('hex');
    await Client.findOneAndUpdate(
      { clientId },
      { $set: { 'logisticsIntegration.webhookSecret': webhookSecret } }
    );
  }

  return {
    partner: client.logisticsPartner || 'unknown',
    partnerLabel: partner.label,
    mode: client.logisticsMode || 'shopify_only',
    planDeclared: !!client.logisticsIntegration?.planDeclared,
    webhookUrl: buildWebhookUrl(clientId, partner.providerCode),
    webhookSecret,
    shiprocketApiEmail: client.logisticsIntegration?.shiprocketApiEmail || '',
    shiprocketApiConfigured: !!(
      client.logisticsIntegration?.shiprocketApiEmail &&
      client.logisticsIntegration?.shiprocketApiPasswordEnc
    ),
    health,
    eligibleRules,
    blockedRules,
    partners: listPartnersForUi().map((p) => ({
      id: p.id,
      label: p.label,
      directPlanLabel: p.directPlanLabel,
      directPlanHelpUrl: p.directPlanHelpUrl,
      shopifyReliableStatuses: p.shopifyReliableStatuses,
    })),
    shopifySyncNote:
      'Shopify sync supports Shipped (fulfillment) and Delivered for most partners. Out for delivery and NDR require direct webhook on an eligible plan.',
  };
}

async function updateLogisticsSettings(clientId, patch = {}) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error('Client not found');

  const set = {};
  if (patch.logisticsPartner) {
    const p = String(patch.logisticsPartner).toLowerCase().trim();
    set.logisticsPartner = getPartnerDef(p).id === 'unknown' && p !== 'unknown' ? 'other' : p;
  }
  if (patch.logisticsMode) {
    const m = String(patch.logisticsMode).toLowerCase().trim();
    if (['shopify_only', 'direct', 'hybrid'].includes(m)) set.logisticsMode = m;
  }
  if (patch.planDeclared === true) {
    set['logisticsIntegration.planDeclared'] = true;
    set['logisticsIntegration.planDeclaredAt'] = new Date();
  }
  if (patch.planDeclared === false) {
    set['logisticsIntegration.planDeclared'] = false;
  }
  if (patch.shiprocketApiEmail !== undefined) {
    set['logisticsIntegration.shiprocketApiEmail'] = String(patch.shiprocketApiEmail || '').trim();
    set['logisticsIntegration.shiprocketTokenEnc'] = '';
    set['logisticsIntegration.shiprocketTokenExpiresAt'] = null;
  }
  if (patch.shiprocketApiPassword !== undefined && String(patch.shiprocketApiPassword).trim()) {
    set['logisticsIntegration.shiprocketApiPasswordEnc'] = encrypt(String(patch.shiprocketApiPassword).trim());
    set['logisticsIntegration.shiprocketTokenEnc'] = '';
    set['logisticsIntegration.shiprocketTokenExpiresAt'] = null;
  }

  if (
    (set.logisticsMode === 'direct' || set.logisticsMode === 'hybrid' || client.logisticsMode === 'direct') &&
    !client.logisticsIntegration?.webhookSecret
  ) {
    set['logisticsIntegration.webhookSecret'] = crypto.randomBytes(18).toString('hex');
  }

  if (Object.keys(set).length) {
    await Client.findOneAndUpdate({ clientId }, { $set: set });
  }

  return getLogisticsProfile(clientId);
}

async function recordObservedShopifyStatus(clientId, status) {
  const s = String(status || '').toLowerCase().trim();
  if (!s) return;
  await Client.findOneAndUpdate(
    { clientId },
    {
      $addToSet: { 'logisticsHealth.observedShopifyStatuses': s },
      $set: {
        'logisticsHealth.shopifyPathActive': true,
        'logisticsHealth.lastHealthCheckAt': new Date(),
      },
    }
  );
}

async function recordDirectWebhookSeen(clientId) {
  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: {
        'logisticsHealth.directWebhookActive': true,
        'logisticsHealth.directWebhookLastSeenAt': new Date(),
        'logisticsHealth.lastHealthCheckAt': new Date(),
      },
    }
  );
}

async function assertShipmentRuleEligible(clientId, ruleId) {
  const client = await Client.findOne({ clientId })
    .select('logisticsPartner logisticsMode logisticsIntegration logisticsHealth')
    .lean();
  if (!client) throw new Error('Client not found');
  const gate = canEnableShipmentRule(client, ruleId);
  if (gate.allowed) return gate;
  const err = new Error(gate.message);
  err.code = gate.code || 'LOGISTICS_NOT_ELIGIBLE';
  err.status = 422;
  err.upgradeHint = gate.upgradeHint;
  err.suggestedMode = gate.suggestedMode;
  err.settingsUrl = gate.settingsUrl;
  throw err;
}

module.exports = {
  buildWebhookUrl,
  normalizeHealth,
  canEnableShipmentRule,
  buildEligibilityMap,
  getLogisticsProfile,
  updateLogisticsSettings,
  recordObservedShopifyStatus,
  recordDirectWebhookSeen,
  assertShipmentRuleEligible,
};
