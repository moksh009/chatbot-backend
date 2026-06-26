'use strict';

const Client = require('../models/Client');
const { buildConnectionStatusPayload } = require('../utils/core/connectionStatus');
const {
  RULE_KIND_OPTIONS,
  MEMBERSHIP_OPERATORS,
  PROPERTIES,
  BEHAVIORS,
  FREQUENCY_OPERATORS,
  TIME_FRAME_OPTIONS,
  RULE_KINDS,
} = require('../constants/segmentRuleCatalog');

function connectionFlagsForCatalog(client) {
  const flags = buildConnectionStatusPayload(client);
  return {
    shopify_connected: Boolean(flags.shopify_connected),
    whatsapp_connected: Boolean(flags.whatsapp_connected),
    email_connected: true,
  };
}

function isEntryEligible(entry, flags) {
  if (entry.eligibility !== 'live') return false;
  const req = entry.requiresConnection || 'any';
  if (req === 'any') return true;
  if (req === 'shopify') return flags.shopify_connected;
  if (req === 'whatsapp') return flags.whatsapp_connected;
  if (req === 'email') return flags.email_connected;
  return true;
}

async function buildSegmentCatalog(clientId) {
  let client = null;
  if (clientId) {
    client = await Client.findOne({ clientId }).select(
      'shopDomain shopifyAccessToken commerce whatsappPhoneNumberId whatsappAccessToken config'
    ).lean();
  }

  const connections = connectionFlagsForCatalog(client);

  const properties = PROPERTIES.filter((p) => isEntryEligible(p, connections)).map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    category: p.category,
    valueType: p.valueType,
    operators: p.operators,
    enumOptions: p.enumOptions || null,
    asyncEndpoint: p.asyncEndpoint || null,
    frequencyOperators: p.frequencyOperators || null,
    supportsTimeFrame: Boolean(p.supportsTimeFrame),
    requiresConnection: p.requiresConnection,
    legacyAssetId: p.legacyAssetId || p.id,
  }));

  const behaviors = BEHAVIORS.filter((b) => isEntryEligible(b, connections)).map((b) => ({
    id: b.id,
    label: b.label,
    description: b.description,
    category: b.category,
    assetId: b.assetId,
    supportsFrequency: Boolean(b.supportsFrequency),
    supportsTimeFrame: Boolean(b.supportsTimeFrame),
    fixedTargetValue: b.fixedTargetValue ?? null,
    requiresConnection: b.requiresConnection,
  }));

  return {
    connections,
    ruleKinds: RULE_KIND_OPTIONS,
    membershipOperators: MEMBERSHIP_OPERATORS,
    frequencyOperators: FREQUENCY_OPERATORS,
    timeFrameOptions: TIME_FRAME_OPTIONS,
    properties,
    behaviors,
    categories: [...new Set(properties.map((p) => p.category))],
  };
}

module.exports = {
  buildSegmentCatalog,
  connectionFlagsForCatalog,
  isEntryEligible,
  RULE_KINDS,
};
