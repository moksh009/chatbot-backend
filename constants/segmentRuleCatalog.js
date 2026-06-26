'use strict';

/**
 * Segment rule catalog — single source of truth for eligible segment fields/events.
 * Only entries with eligibility: 'live' are exposed via GET /api/segments/catalog.
 */

const RULE_KINDS = {
  PROPERTY: 'property',
  BEHAVIOR: 'behavior',
  SEGMENT_MEMBERSHIP: 'segment_membership',
};

const CATEGORIES = {
  IDENTITY: 'Identity',
  COMMERCE: 'Commerce',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  ATTRIBUTION: 'Attribution',
  TAGS: 'Tags',
  OPT_IN: 'Opt-in & consent',
};

const TEXT_OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does not equal' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_contains', label: 'Does not contain' },
  { value: 'is_set', label: 'Is set' },
  { value: 'is_not_set', label: 'Is not set' },
];

const NUMBER_OPERATORS = [
  { value: '>=', label: 'Greater than or equal to' },
  { value: '<=', label: 'Less than or equal to' },
  { value: '===', label: 'Exactly equals' },
  { value: 'between', label: 'Between' },
];

const ENUM_OPERATORS = [
  { value: '===', label: 'Is' },
  { value: '!==', label: 'Is not' },
];

const CALCULATED_DAYS_OPERATORS = [
  { value: '<=', label: 'Within last (days)' },
  { value: '>=', label: 'More than (days) ago' },
];

const BOOLEAN_OPERATORS = [
  { value: '===', label: 'Is' },
];

const FREQUENCY_OPERATORS = [
  { value: 'atleast_once', label: 'At least once' },
  { value: 'zero_times', label: 'Zero times' },
  { value: 'atleast_x', label: 'At least X times' },
  { value: 'exactly_x', label: 'Exactly X times' },
  { value: 'atmost_x', label: 'At most X times' },
];

const TIME_FRAME_OPTIONS = [
  { value: 'all_time', label: 'Over all time' },
  { value: 'within_last', label: 'Within last' },
  { value: 'not_within_last', label: 'Not within last' },
  { value: 'before', label: 'Before' },
  { value: 'after', label: 'After' },
  { value: 'between', label: 'Between' },
];

const RULE_KIND_OPTIONS = [
  {
    value: RULE_KINDS.PROPERTY,
    label: 'Properties about someone',
    description: 'Filter by name, orders, LTV, opt-in, tags, and other profile fields.',
  },
  {
    value: RULE_KINDS.BEHAVIOR,
    label: 'What someone has done (or not done)',
    description: 'Filter by orders placed, checkouts, cart activity, or WhatsApp messages.',
  },
  {
    value: RULE_KINDS.SEGMENT_MEMBERSHIP,
    label: 'If someone is in or not in a segment',
    description: 'Include or exclude people who match another saved segment.',
  },
];

const MEMBERSHIP_OPERATORS = [
  { value: 'in', label: 'Is in' },
  { value: 'not_in', label: 'Is not in' },
];

/** @type {import('./segmentRuleCatalog').CatalogProperty[]} */
const PROPERTIES = [
  {
    id: 'NAME',
    label: 'Name',
    description: 'Customer display name from Shopify or WhatsApp.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.IDENTITY,
    valueType: 'text',
    operators: TEXT_OPERATORS,
    dataBinding: 'name',
    requiresConnection: 'any',
    eligibility: 'live',
  },
  {
    id: 'EMAIL',
    label: 'Email',
    description: 'Email address on the contact profile.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.IDENTITY,
    valueType: 'text',
    operators: TEXT_OPERATORS,
    dataBinding: 'email',
    requiresConnection: 'any',
    eligibility: 'live',
  },
  {
    id: 'PHONE',
    label: 'Phone number',
    description: 'WhatsApp or checkout phone on file.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.IDENTITY,
    valueType: 'text',
    operators: [
      { value: 'is_set', label: 'Is set' },
      { value: 'is_not_set', label: 'Is not set' },
      { value: 'contains', label: 'Contains' },
    ],
    dataBinding: 'phoneNumber',
    requiresConnection: 'any',
    eligibility: 'live',
  },
  {
    id: 'TOTAL_ORDERS',
    label: 'Number of orders',
    description: 'Completed Shopify orders for this customer.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.COMMERCE,
    valueType: 'frequency',
    operators: NUMBER_OPERATORS,
    frequencyOperators: FREQUENCY_OPERATORS,
    supportsTimeFrame: true,
    dataBinding: 'ordersCount',
    requiresConnection: 'shopify',
    eligibility: 'live',
    legacyAssetId: 'TOTAL_ORDERS',
  },
  {
    id: 'LTV',
    label: 'Lifetime value (₹)',
    description: 'Total amount spent across orders.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.COMMERCE,
    valueType: 'number',
    operators: NUMBER_OPERATORS,
    dataBinding: 'totalSpent',
    requiresConnection: 'shopify',
    eligibility: 'live',
    legacyAssetId: 'LTV',
  },
  {
    id: 'AOV',
    label: 'Average order value (₹)',
    description: 'Lifetime value divided by order count.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.COMMERCE,
    valueType: 'number',
    operators: NUMBER_OPERATORS,
    dataBinding: 'averageOrderValue',
    requiresConnection: 'shopify',
    eligibility: 'live',
  },
  {
    id: 'CART_STATUS',
    label: 'Cart status',
    description: 'Current abandoned-cart or purchase state.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.COMMERCE,
    valueType: 'enum',
    operators: ENUM_OPERATORS,
    enumOptions: [
      { value: 'active', label: 'Active' },
      { value: 'abandoned', label: 'Abandoned' },
      { value: 'recovered', label: 'Recovered' },
      { value: 'purchased', label: 'Purchased' },
      { value: 'failed', label: 'Failed' },
    ],
    dataBinding: 'cartStatus',
    requiresConnection: 'shopify',
    eligibility: 'live',
    legacyAssetId: 'CART_STATUS',
  },
  {
    id: 'CART_VALUE',
    label: 'Open cart value (₹)',
    description: 'Value of the current open cart.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.COMMERCE,
    valueType: 'number',
    operators: NUMBER_OPERATORS,
    dataBinding: 'cartValue',
    requiresConnection: 'shopify',
    eligibility: 'live',
    legacyAssetId: 'CART_VALUE',
  },
  {
    id: 'DAYS_SINCE_LAST_PURCHASE',
    label: 'Days since last order',
    description: 'How long ago the customer last purchased.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.COMMERCE,
    valueType: 'calculated_days',
    operators: CALCULATED_DAYS_OPERATORS,
    dataBinding: 'lastPurchaseDate',
    requiresConnection: 'shopify',
    eligibility: 'live',
    legacyAssetId: 'DAYS_SINCE_LAST_PURCHASE',
  },
  {
    id: 'LEAD_SCORE',
    label: 'Lead score',
    description: 'Engagement score from WhatsApp and store activity.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.WHATSAPP,
    valueType: 'number',
    operators: NUMBER_OPERATORS,
    dataBinding: 'leadScore',
    requiresConnection: 'whatsapp',
    eligibility: 'live',
    legacyAssetId: 'LEAD_SCORE',
  },
  {
    id: 'DAYS_SINCE_LAST_SEEN',
    label: 'Days since last active',
    description: 'Days since last WhatsApp or store interaction.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.WHATSAPP,
    valueType: 'calculated_days',
    operators: CALCULATED_DAYS_OPERATORS,
    dataBinding: 'lastInteraction',
    requiresConnection: 'any',
    eligibility: 'live',
    legacyAssetId: 'DAYS_SINCE_LAST_SEEN',
  },
  {
    id: 'OPT_STATUS',
    label: 'WhatsApp marketing opt-in',
    description: 'Whether the contact can receive WhatsApp marketing.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.WHATSAPP,
    valueType: 'enum',
    operators: ENUM_OPERATORS,
    enumOptions: [
      { value: 'opted_in', label: 'Opted in' },
      { value: 'opted_out', label: 'Opted out' },
      { value: 'unknown', label: 'Unknown' },
      { value: 'pending', label: 'Pending' },
    ],
    dataBinding: 'optStatus',
    requiresConnection: 'whatsapp',
    eligibility: 'live',
    legacyAssetId: 'OPT_STATUS',
  },
  {
    id: 'EMAIL_CONSENT',
    label: 'Email marketing consent',
    description: 'Email channel consent status on the contact.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.EMAIL,
    valueType: 'enum',
    operators: ENUM_OPERATORS,
    enumOptions: [
      { value: 'opted_in', label: 'Opted in' },
      { value: 'opted_out', label: 'Opted out' },
      { value: 'unknown', label: 'Unknown' },
      { value: 'pending', label: 'Pending' },
    ],
    dataBinding: 'channelConsent.email.status',
    requiresConnection: 'email',
    eligibility: 'live',
  },
  {
    id: 'LEAD_SOURCE',
    label: 'Lead source',
    description: 'How the contact entered your CRM.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.ATTRIBUTION,
    valueType: 'text',
    operators: [...TEXT_OPERATORS.filter((o) => o.value !== 'is_not_set'), { value: 'equals', label: 'Equals' }],
    dataBinding: 'source',
    requiresConnection: 'any',
    eligibility: 'live',
    legacyAssetId: 'LEAD_SOURCE',
  },
  {
    id: 'AD_CHANNEL',
    label: 'Ad / discovery channel',
    description: 'Meta or organic attribution channel.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.ATTRIBUTION,
    valueType: 'text',
    operators: TEXT_OPERATORS.filter((o) => ['equals', 'contains', 'is_set', 'is_not_set'].includes(o.value)),
    dataBinding: 'adAttribution.source',
    requiresConnection: 'any',
    eligibility: 'live',
    legacyAssetId: 'AD_CHANNEL',
  },
  {
    id: 'HAS_TAG',
    label: 'Has tag',
    description: 'Contact has a specific CRM tag.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.TAGS,
    valueType: 'text',
    operators: [{ value: 'equals', label: 'Equals' }, { value: 'contains', label: 'Contains' }],
    dataBinding: 'tags',
    requiresConnection: 'any',
    eligibility: 'live',
    legacyAssetId: 'HAS_TAG',
  },
  {
    id: 'JUST_LANDED',
    label: 'Just landed (new contact)',
    description: 'New WhatsApp contact with no orders yet.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.WHATSAPP,
    valueType: 'boolean',
    operators: BOOLEAN_OPERATORS,
    dataBinding: 'justLanded',
    requiresConnection: 'whatsapp',
    eligibility: 'live',
    legacyAssetId: 'JUST_LANDED',
  },
  {
    id: 'OPT_IN_SOURCE',
    label: 'Opt-in source',
    description: 'Which type of opt-in tool captured this lead.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.OPT_IN,
    valueType: 'enum',
    operators: ENUM_OPERATORS,
    enumOptions: [
      { value: 'spin_wheel', label: 'Spin Wheel' },
      { value: 'website_popup', label: 'Website Popup' },
      { value: 'mystery_discount', label: 'Mystery Discount' },
      { value: 'whatsapp_widget', label: 'WhatsApp Widget' },
    ],
    dataBinding: 'optInSource',
    requiresConnection: 'any',
    eligibility: 'live',
  },
  {
    id: 'OPT_IN_TOOL',
    label: 'Opt-in tool',
    description: 'The specific opt-in tool that captured this lead.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.OPT_IN,
    valueType: 'async_enum',
    operators: ENUM_OPERATORS,
    asyncEndpoint: '/api/opt-in-tools?status=published,paused&fields=_id,name,type',
    dataBinding: 'optInToolId',
    requiresConnection: 'any',
    eligibility: 'live',
  },
  {
    id: 'PRIZE_WON',
    label: 'Prize won',
    description: 'Prize label captured from spin wheel or mystery discount.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.OPT_IN,
    valueType: 'text',
    operators: [
      { value: 'is_set', label: 'Has won a prize' },
      { value: 'is_not_set', label: 'No prize won' },
      { value: 'equals', label: 'Equals' },
      { value: 'contains', label: 'Contains' },
    ],
    dataBinding: 'capturedData.prizeLabel',
    requiresConnection: 'any',
    eligibility: 'live',
  },
  {
    id: 'HAS_OPT_IN_COUPON',
    label: 'Has opt-in coupon',
    description: 'Contact received a coupon code via opt-in tool.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.OPT_IN,
    valueType: 'text',
    operators: [
      { value: 'is_set', label: 'Has coupon' },
      { value: 'is_not_set', label: 'No coupon' },
    ],
    dataBinding: 'capturedData.optInCouponCode',
    requiresConnection: 'any',
    eligibility: 'live',
  },
  {
    id: 'OPT_IN_DATE',
    label: 'Opt-in date',
    description: 'When the contact opted in via a website tool.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.OPT_IN,
    valueType: 'calculated_days',
    operators: [
      { value: '<=', label: 'Within last (days)' },
      { value: '>=', label: 'More than (days) ago' },
    ],
    dataBinding: 'optInDate',
    requiresConnection: 'any',
    eligibility: 'live',
  },
  {
    id: 'VISITOR_COUNT',
    label: 'Store visit count',
    description: 'Number of site visits tracked by the web pixel.',
    ruleKind: RULE_KINDS.PROPERTY,
    category: CATEGORIES.OPT_IN,
    valueType: 'number',
    operators: NUMBER_OPERATORS,
    dataBinding: 'visitorVisitCount',
    requiresConnection: 'any',
    eligibility: 'live',
  },
];

/** @type {import('./segmentRuleCatalog').CatalogBehavior[]} */
const BEHAVIORS = [
  {
    id: 'BEHAVIOR_ORDER_PLACED',
    label: 'Placed an order',
    description: 'Customer completed at least one Shopify order.',
    ruleKind: RULE_KINDS.BEHAVIOR,
    category: CATEGORIES.COMMERCE,
    assetId: 'TOTAL_ORDERS',
    supportsFrequency: true,
    supportsTimeFrame: true,
    requiresConnection: 'shopify',
    eligibility: 'live',
  },
  {
    id: 'BEHAVIOR_CHECKOUT_STARTED',
    label: 'Started checkout',
    description: 'Customer initiated checkout at least once.',
    ruleKind: RULE_KINDS.BEHAVIOR,
    category: CATEGORIES.COMMERCE,
    assetId: 'CHECKOUTS_STARTED',
    supportsFrequency: true,
    supportsTimeFrame: true,
    requiresConnection: 'shopify',
    eligibility: 'live',
  },
  {
    id: 'BEHAVIOR_CART_ABANDONED',
    label: 'Abandoned cart',
    description: 'Cart is currently in abandoned state.',
    ruleKind: RULE_KINDS.BEHAVIOR,
    category: CATEGORIES.COMMERCE,
    assetId: 'CART_STATUS',
    fixedTargetValue: 'abandoned',
    supportsFrequency: false,
    supportsTimeFrame: false,
    requiresConnection: 'shopify',
    eligibility: 'live',
  },
  {
    id: 'BEHAVIOR_ADD_TO_CART',
    label: 'Added to cart',
    description: 'Add-to-cart events tracked from your store pixel.',
    ruleKind: RULE_KINDS.BEHAVIOR,
    category: CATEGORIES.COMMERCE,
    assetId: 'ABANDONED_CARTS',
    supportsFrequency: true,
    supportsTimeFrame: true,
    requiresConnection: 'shopify',
    eligibility: 'live',
  },
  {
    id: 'BEHAVIOR_WA_MESSAGE',
    label: 'Sent a WhatsApp message',
    description: 'Inbound WhatsApp messages from the customer.',
    ruleKind: RULE_KINDS.BEHAVIOR,
    category: CATEGORIES.WHATSAPP,
    assetId: 'TOTAL_INTERACTIONS',
    supportsFrequency: true,
    supportsTimeFrame: true,
    requiresConnection: 'whatsapp',
    eligibility: 'live',
  },
];

const PROPERTY_BY_ID = Object.fromEntries(PROPERTIES.map((p) => [p.id, p]));
const BEHAVIOR_BY_ID = Object.fromEntries(BEHAVIORS.map((b) => [b.id, b]));

function getCatalogEntryByAssetId(assetId) {
  const id = String(assetId || '').trim();
  const prop = PROPERTIES.find((p) => p.id === id || p.legacyAssetId === id);
  if (prop) return prop;
  const behavior = BEHAVIORS.find((b) => b.assetId === id);
  if (behavior) return { ...behavior, id: behavior.assetId };
  return null;
}

function inferRuleKind(rule = {}) {
  if (rule.ruleKind) return rule.ruleKind;
  if (rule.segmentId) return RULE_KINDS.SEGMENT_MEMBERSHIP;
  if (rule.behaviorId) return RULE_KINDS.BEHAVIOR;
  return RULE_KINDS.PROPERTY;
}

module.exports = {
  RULE_KINDS,
  CATEGORIES,
  TEXT_OPERATORS,
  NUMBER_OPERATORS,
  ENUM_OPERATORS,
  CALCULATED_DAYS_OPERATORS,
  BOOLEAN_OPERATORS,
  FREQUENCY_OPERATORS,
  TIME_FRAME_OPTIONS,
  RULE_KIND_OPTIONS,
  MEMBERSHIP_OPERATORS,
  PROPERTIES,
  BEHAVIORS,
  PROPERTY_BY_ID,
  BEHAVIOR_BY_ID,
  getCatalogEntryByAssetId,
  inferRuleKind,
};
