'use strict';

/**
 * Logistics partners — plan gates, setup copy, shipment status paths.
 * Keep in sync with chatbot-dashboard-frontend-main/src/config/logisticsPartnerCatalog.js
 */

const SHIPMENT_STATUSES = [
  'in_transit',
  'out_for_delivery',
  'delivered',
  'attempted_delivery',
  'failure',
];

const SHOPIFY_DEFAULT_RELIABLE = new Set(['delivered']);

const GRANULAR_STATUSES = new Set([
  'in_transit',
  'out_for_delivery',
  'attempted_delivery',
  'failure',
]);

const DEFAULT_SHOPIFY_NOTE =
  'Connect your shipping app in Shopify admin. TopEdge reads fulfillment updates for Shipped and Delivered.';

function partnerBase(overrides) {
  return {
    shopifyReliableStatuses: ['delivered'],
    directWebhookStatuses: SHIPMENT_STATUSES,
    webhookUrlLimit: null,
    supportsDirectWebhook: true,
    shopifySetupNote: DEFAULT_SHOPIFY_NOTE,
    ...overrides,
  };
}

const LOGISTICS_PARTNERS = {
  shiprocket: partnerBase({
    id: 'shiprocket',
    label: 'Shiprocket',
    category: 'india_aggregator',
    region: 'IN',
    providerCode: 'sr',
    shopifyApp: true,
    directWebhookMinPlan: 'advanced',
    directPlanLabel: 'Shiprocket Advanced plan (₹499/month or higher)',
    directPlanHelpUrl: 'https://www.shiprocket.in/pricing/',
    webhookUrlLimit: 1,
    setupSteps: ['plan_confirm', 'webhook_paste', 'api_user_optional'],
    webhookPastePath: 'Settings → API → Webhooks',
    setupCopy: [
      'Confirm you are on Shiprocket Advanced (₹499/mo+).',
      'Open Settings → API → Webhooks in Shiprocket.',
      'Paste the TopEdge webhook URL (must not contain the word "shiprocket").',
      'Add header x-api-key with the secret we provide.',
      'Optional: add API user credentials for NDR auto push-back.',
    ],
    shopifySetupNote:
      'Install the Shiprocket Shopify app. Shopify sync covers Shipped and Delivered; direct webhook unlocks out-for-delivery and NDR.',
  }),
  nimbuspost: partnerBase({
    id: 'nimbuspost',
    label: 'NimbusPost',
    category: 'india_aggregator',
    region: 'IN',
    providerCode: 'np',
    shopifyApp: true,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'Active NimbusPost business account with API access',
    directPlanHelpUrl: 'https://nimbuspost.com/pricing/',
    setupSteps: ['webhook_paste', 'api_credentials'],
    webhookPastePath: 'Settings → Integrations → Webhooks',
    setupCopy: [
      'Open NimbusPost → Settings → Integrations → Webhooks.',
      'Paste the TopEdge webhook URL.',
      'Add x-api-key header with the secret below if prompted.',
      'Ship a test order and wait for the first tracking scan.',
    ],
  }),
  ithink: partnerBase({
    id: 'ithink',
    label: 'iThink Logistics',
    category: 'india_aggregator',
    region: 'IN',
    providerCode: 'itl',
    shopifyApp: true,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'iThink account with API key enabled',
    directPlanHelpUrl: 'https://www.ithinklogistics.com/',
    setupSteps: ['api_credentials', 'webhook_paste'],
    webhookPastePath: 'Panel → API → Webhook URL',
    setupCopy: [
      'Enable API access in your iThink Logistics panel.',
      'Paste the TopEdge webhook URL under Webhook settings.',
      'Add the x-api-key secret header if required.',
    ],
  }),
  shyplite: partnerBase({
    id: 'shyplite',
    label: 'Shyplite',
    category: 'india_aggregator',
    region: 'IN',
    providerCode: 'sh',
    shopifyApp: true,
    directWebhookMinPlan: 'api_enabled',
    directPlanLabel: 'Shyplite API enabled in Settings → API',
    directPlanHelpUrl: 'https://shyplite.com/',
    setupSteps: ['api_enable', 'webhook_paste'],
    webhookPastePath: 'Settings → API → Webhooks',
    setupCopy: [
      'Enable API in Shyplite Settings → API.',
      'Paste the TopEdge webhook URL in Webhooks.',
      'Add x-api-key header with our secret.',
    ],
  }),
  shipway: partnerBase({
    id: 'shipway',
    label: 'Shipway',
    category: 'india_aggregator',
    region: 'IN',
    providerCode: 'sw',
    shopifyApp: true,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'Active Shipway account with webhook access',
    directPlanHelpUrl: 'https://www.shipway.com/',
    setupSteps: ['webhook_paste'],
    webhookPastePath: 'Settings → Webhooks',
    setupCopy: [
      'Connect Shipway to your Shopify store.',
      'Open Shipway → Settings → Webhooks.',
      'Paste the TopEdge URL and save.',
    ],
    shopifySetupNote:
      'Shipway automates courier allocation. Shopify sync covers basics; direct webhook adds granular tracking.',
  }),
  easyship: partnerBase({
    id: 'easyship',
    label: 'Easyship',
    category: 'india_aggregator',
    region: 'GLOBAL',
    providerCode: 'es',
    shopifyApp: true,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'Easyship account with webhook notifications enabled',
    directPlanHelpUrl: 'https://www.easyship.com/',
    setupSteps: ['webhook_paste'],
    webhookPastePath: 'Settings → Webhooks',
    setupCopy: [
      'Install Easyship on Shopify for rate calculation and labels.',
      'In Easyship → Settings → Webhooks, paste the TopEdge URL.',
      'Enable shipment status events.',
    ],
    shopifySetupNote:
      'Easyship connects global carriers in one dashboard. Best for international Shopify stores.',
  }),
  shippo: partnerBase({
    id: 'shippo',
    label: 'Shippo',
    category: 'india_aggregator',
    region: 'GLOBAL',
    providerCode: 'sp',
    shopifyApp: true,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'Shippo account with webhook access',
    directPlanHelpUrl: 'https://goshippo.com/',
    setupSteps: ['webhook_paste'],
    webhookPastePath: 'Settings → API → Webhooks',
    setupCopy: [
      'Connect Shippo to Shopify for discounted carrier rates.',
      'Paste the TopEdge webhook URL in Shippo webhook settings.',
      'Subscribe to track_updated events.',
    ],
  }),
  delhivery: partnerBase({
    id: 'delhivery',
    label: 'Delhivery',
    category: 'india_courier',
    region: 'IN',
    providerCode: 'del',
    shopifyApp: true,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'Delhivery business account with API/webhook access',
    directPlanHelpUrl: 'https://www.delhivery.com/',
    setupSteps: ['webhook_paste'],
    webhookPastePath: 'Client panel → Webhooks',
    setupCopy: [
      'Use Delhivery via Shiprocket, Shipway, or the Delhivery Shopify app.',
      'For direct webhook: paste TopEdge URL in Delhivery client panel webhooks.',
      'Payload must include order_id, awb, and shipment_status fields.',
    ],
    shopifySetupNote:
      'Most merchants route Delhivery through an aggregator app on Shopify. Direct webhook is optional for granular scans.',
  }),
  bluedart: partnerBase({
    id: 'bluedart',
    label: 'Blue Dart',
    category: 'india_courier',
    region: 'IN',
    providerCode: 'bd',
    shopifyApp: false,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'Blue Dart enterprise account with tracking API',
    directPlanHelpUrl: 'https://www.bluedart.com/',
    setupSteps: ['webhook_paste'],
    webhookPastePath: 'Enterprise portal → Webhook notifications',
    setupCopy: [
      'Blue Dart is usually booked via Shiprocket or your 3PL.',
      'Enterprise accounts can paste the TopEdge URL in webhook settings.',
      'Ensure AWB and status fields are sent on each scan.',
    ],
    shopifySetupNote:
      'Book Blue Dart through an aggregator on Shopify for simplest setup. Enterprise direct webhook available.',
  }),
  xpressbees: partnerBase({
    id: 'xpressbees',
    label: 'XpressBees',
    category: 'india_courier',
    region: 'IN',
    providerCode: 'xb',
    shopifyApp: true,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'XpressBees merchant account',
    directPlanHelpUrl: 'https://www.xpressbees.com/',
    setupSteps: ['webhook_paste'],
    webhookPastePath: 'Merchant panel → API → Webhooks',
    setupCopy: [
      'Connect via Shiprocket/Shipway or XpressBees Shopify integration.',
      'Paste TopEdge webhook URL in merchant panel.',
    ],
  }),
  dtdc: partnerBase({
    id: 'dtdc',
    label: 'DTDC',
    category: 'india_courier',
    region: 'IN',
    providerCode: 'dtdc',
    shopifyApp: false,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'DTDC business account',
    directPlanHelpUrl: 'https://www.dtdc.in/',
    setupSteps: ['webhook_paste'],
    webhookPastePath: 'Business portal → Webhook settings',
    setupCopy: [
      'Route DTDC through your shipping aggregator on Shopify.',
      'Direct webhook: paste URL in DTDC business portal if available.',
    ],
  }),
  ekart: partnerBase({
    id: 'ekart',
    label: 'Ekart Logistics',
    category: 'india_courier',
    region: 'IN',
    providerCode: 'ek',
    shopifyApp: false,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'Ekart seller account with tracking API',
    directPlanHelpUrl: 'https://www.ekartlogistics.com/',
    setupSteps: ['webhook_paste'],
    webhookPastePath: 'Seller hub → Integrations → Webhooks',
    setupCopy: [
      'Ekart is often used via marketplace or aggregator routing.',
      'Paste TopEdge URL in Ekart seller hub webhook settings for direct updates.',
    ],
  }),
  usps: partnerBase({
    id: 'usps',
    label: 'USPS',
    category: 'global_carrier',
    region: 'US',
    providerCode: 'usps',
    shopifyApp: true,
    directWebhookMinPlan: null,
    directPlanLabel: null,
    directPlanHelpUrl: 'https://www.shopify.com/shipping/carriers',
    setupSteps: ['shopify_shipping'],
    webhookPastePath: 'Shopify Shipping → USPS',
    setupCopy: [
      'Enable USPS in Shopify admin → Settings → Shipping and delivery.',
      'TopEdge reads fulfillment updates from Shopify for Shipped and Delivered.',
      'For granular scans, use Shippo/Easyship with direct webhook mode.',
    ],
    supportsDirectWebhook: false,
    directWebhookStatuses: [],
    shopifySetupNote:
      'USPS via Shopify Shipping covers domestic US labels. Granular tracking may need Shippo or Easyship direct webhook.',
  }),
  ups: partnerBase({
    id: 'ups',
    label: 'UPS',
    category: 'global_carrier',
    region: 'GLOBAL',
    providerCode: 'ups',
    shopifyApp: true,
    directWebhookMinPlan: null,
    directPlanLabel: null,
    directPlanHelpUrl: 'https://www.shopify.com/shipping/carriers',
    setupSteps: ['shopify_shipping'],
    webhookPastePath: 'Shopify Shipping → UPS',
    setupCopy: [
      'Connect UPS in Shopify Shipping settings.',
      'Fulfillment updates flow through Shopify sync automatically.',
    ],
    supportsDirectWebhook: false,
    directWebhookStatuses: [],
  }),
  fedex: partnerBase({
    id: 'fedex',
    label: 'FedEx',
    category: 'global_carrier',
    region: 'GLOBAL',
    providerCode: 'fdx',
    shopifyApp: true,
    directWebhookMinPlan: null,
    directPlanLabel: null,
    directPlanHelpUrl: 'https://www.fedex.com/',
    setupSteps: ['shopify_shipping'],
    webhookPastePath: 'Shopify Shipping or Shippo → FedEx',
    setupCopy: [
      'Use Shopify Shipping, Shippo, or Easyship for FedEx labels.',
      'Shopify sync covers Shipped and Delivered order messages.',
    ],
    supportsDirectWebhook: false,
    directWebhookStatuses: [],
  }),
  dhl: partnerBase({
    id: 'dhl',
    label: 'DHL Express',
    category: 'global_carrier',
    region: 'GLOBAL',
    providerCode: 'dhl',
    shopifyApp: true,
    directWebhookMinPlan: 'active_account',
    directPlanLabel: 'DHL Express business account with webhook notifications',
    directPlanHelpUrl: 'https://www.dhl.com/',
    setupSteps: ['webhook_paste', 'shopify_shipping'],
    webhookPastePath: 'MyDHL+ → Webhooks',
    setupCopy: [
      'Connect DHL via Easyship or Shopify Shipping for international orders.',
      'DHL Express business accounts can paste TopEdge URL in MyDHL+ webhooks.',
    ],
  }),
  other: partnerBase({
    id: 'other',
    label: 'Other / manual shipping',
    category: 'other',
    region: 'GLOBAL',
    providerCode: 'ot',
    shopifyApp: false,
    directWebhookMinPlan: null,
    directPlanLabel: null,
    directWebhookStatuses: [],
    supportsDirectWebhook: false,
    setupSteps: [],
    setupCopy: [],
    shopifySetupNote: 'Use Shopify sync for fulfillments you mark manually in admin.',
  }),
  shopify: partnerBase({
    id: 'shopify',
    label: 'Shopify only',
    category: 'shopify',
    region: 'GLOBAL',
    providerCode: 'ot',
    shopifyApp: true,
    directWebhookMinPlan: null,
    directPlanLabel: null,
    directWebhookStatuses: [],
    supportsDirectWebhook: false,
    setupSteps: [],
    setupCopy: [],
    shopifyReliableStatuses: ['delivered'],
    shopifySetupNote:
      'Shopify is your store — not a courier. Shipped and Delivered work via Shopify; out for delivery and NDR need a shipping partner.',
  }),
  unknown: partnerBase({
    id: 'unknown',
    label: 'Not selected',
    category: 'other',
    region: 'GLOBAL',
    providerCode: 'ot',
    shopifyApp: false,
    directWebhookMinPlan: null,
    directPlanLabel: null,
    directWebhookStatuses: [],
    supportsDirectWebhook: false,
    setupSteps: [],
    setupCopy: [],
  }),
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
