'use strict';

/**
 * Indian logistics partners — plan gates + which shipment statuses each data path supports.
 * Keep in sync with chatbot-dashboard-frontend-main/src/config/logisticsPartnerCatalog.js
 */

const SHIPMENT_STATUSES = [
  'in_transit',
  'out_for_delivery',
  'delivered',
  'attempted_delivery',
  'failure',
];

/** Statuses Shiprocket default Shopify mapper reliably pushes (see SR push status table). */
const SHOPIFY_DEFAULT_RELIABLE = new Set(['delivered']);

/** Granular statuses that need direct webhook OR observed Shopify fulfillment.shipment_status. */
const GRANULAR_STATUSES = new Set([
  'in_transit',
  'out_for_delivery',
  'attempted_delivery',
  'failure',
]);

const LOGISTICS_PARTNERS = {
  shiprocket: {
    id: 'shiprocket',
    label: 'Shiprocket',
    providerCode: 'sr',
    shopifyApp: true,
    directWebhookMinPlan: 'advanced',
    directPlanLabel: 'Shiprocket Advanced plan (₹499/month or higher)',
    directPlanHelpUrl: 'https://www.shiprocket.in/pricing/',
    shopifyReliableStatuses: ['delivered'],
    directWebhookStatuses: SHIPMENT_STATUSES,
    webhookUrlLimit: 1,
    setupSteps: ['plan_confirm', 'webhook_paste', 'api_user_optional'],
  },
  nimbuspost: {
    id: 'nimbuspost',
    label: 'NimbusPost',
    providerCode: 'np',
    shopifyApp: true,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'Active NimbusPost business account with API access',
    directPlanHelpUrl: 'https://nimbuspost.com/pricing/',
    shopifyReliableStatuses: ['delivered'],
    directWebhookStatuses: SHIPMENT_STATUSES,
    webhookUrlLimit: null,
    setupSteps: ['webhook_paste', 'api_credentials'],
  },
  ithink: {
    id: 'ithink',
    label: 'iThink Logistics',
    providerCode: 'itl',
    shopifyApp: true,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'iThink account with API key enabled',
    directPlanHelpUrl: 'https://www.ithinklogistics.com/',
    shopifyReliableStatuses: ['delivered'],
    directWebhookStatuses: SHIPMENT_STATUSES,
    webhookUrlLimit: null,
    setupSteps: ['api_credentials', 'webhook_paste'],
  },
  shyplite: {
    id: 'shyplite',
    label: 'Shyplite',
    providerCode: 'sh',
    shopifyApp: true,
    directWebhookMinPlan: 'api_enabled',
    directPlanLabel: 'Shyplite API enabled in Settings → API',
    directPlanHelpUrl: 'https://shyplite.com/',
    shopifyReliableStatuses: ['delivered'],
    directWebhookStatuses: SHIPMENT_STATUSES,
    webhookUrlLimit: null,
    setupSteps: ['api_enable', 'webhook_paste'],
  },
  other: {
    id: 'other',
    label: 'Other / manual shipping',
    providerCode: 'ot',
    shopifyApp: false,
    directWebhookMinPlan: null,
    directPlanLabel: null,
    shopifyReliableStatuses: ['delivered'],
    directWebhookStatuses: [],
    webhookUrlLimit: null,
    setupSteps: [],
  },
  unknown: {
    id: 'unknown',
    label: 'Not selected',
    providerCode: 'ot',
    shopifyApp: false,
    directWebhookMinPlan: null,
    directPlanLabel: null,
    shopifyReliableStatuses: ['delivered'],
    directWebhookStatuses: [],
    webhookUrlLimit: null,
    setupSteps: [],
  },
};

const RULE_ID_PREFIX = 'sys_shipment_';

function ruleIdToShipmentStatus(ruleId) {
  const id = String(ruleId || '');
  if (!id.startsWith(RULE_ID_PREFIX)) return null;
  return id.slice(RULE_ID_PREFIX.length);
}

function shipmentStatusToRuleId(status) {
  const s = String(status || '').toLowerCase().trim();
  if (!s) return null;
  return `${RULE_ID_PREFIX}${s}`;
}

function getPartnerDef(partnerId) {
  const key = String(partnerId || 'unknown').toLowerCase().trim();
  return LOGISTICS_PARTNERS[key] || LOGISTICS_PARTNERS.unknown;
}

function listPartnersForUi() {
  return Object.values(LOGISTICS_PARTNERS).filter((p) => p.id !== 'unknown');
}

module.exports = {
  SHIPMENT_STATUSES,
  SHOPIFY_DEFAULT_RELIABLE,
  GRANULAR_STATUSES,
  LOGISTICS_PARTNERS,
  RULE_ID_PREFIX,
  ruleIdToShipmentStatus,
  shipmentStatusToRuleId,
  getPartnerDef,
  listPartnersForUi,
};
