// Centralized Data Dictionary for Lead Scoring & Segmentation
const TRACKABLE_ASSETS = {
  CATEGORIES: {
    COMMERCE: 'Shopify / Commerce',
    ENGAGEMENT: 'WhatsApp / Engagement',
    ATTRIBUTION: 'Source & ads',
    COMPLIANCE: 'WhatsApp consent'
  },
  ASSETS: {
    NAME: {
      id: 'NAME',
      label: 'Name',
      category: 'ENGAGEMENT',
      type: 'TEXT',
      dbField: 'name',
    },
    EMAIL: {
      id: 'EMAIL',
      label: 'Email',
      category: 'ENGAGEMENT',
      type: 'TEXT',
      dbField: 'email',
    },
    PHONE: {
      id: 'PHONE',
      label: 'Phone number',
      category: 'ENGAGEMENT',
      type: 'TEXT',
      dbField: 'phoneNumber',
    },
    AOV: {
      id: 'AOV',
      label: 'Average order value',
      category: 'COMMERCE',
      type: 'COMPUTED_NUMBER',
      dbField: 'averageOrderValue',
    },
    EMAIL_CONSENT: {
      id: 'EMAIL_CONSENT',
      label: 'Email marketing consent',
      category: 'COMPLIANCE',
      type: 'STRING',
      dbField: 'channelConsent.email.status',
    },
    // COMMERCE
    CART_VALUE: {
      id: 'CART_VALUE',
      label: 'Open cart value (₹)',
      category: 'COMMERCE',
      type: 'NUMBER',
      dbField: 'cartValue'
    },
    CHECKOUTS_STARTED: {
      id: 'CHECKOUTS_STARTED',
      label: 'Checkouts started (count)',
      category: 'COMMERCE',
      type: 'NUMBER',
      dbField: 'checkoutInitiatedCount'
    },
    CART_STATUS: {
      id: 'CART_STATUS',
      label: 'Cart / purchase state',
      category: 'COMMERCE',
      type: 'STRING',
      dbField: 'cartStatus',
      /** allowed: active, abandoned, recovered, purchased, failed */
    },
    TOTAL_ORDERS: {
      id: 'TOTAL_ORDERS',
      label: 'Total Orders',
      category: 'COMMERCE',
      type: 'NUMBER',
      dbField: 'ordersCount' // Maps to actual AdLead schema field
    },
    LTV: {
      id: 'LTV',
      label: 'Lifetime Value (LTV)',
      category: 'COMMERCE',
      type: 'NUMBER',
      dbField: 'totalSpent'
    },
    ABANDONED_CARTS: {
      id: 'ABANDONED_CARTS',
      label: 'Abandoned Carts',
      category: 'COMMERCE',
      type: 'NUMBER',
      dbField: 'addToCartCount' // Or whatever specific field tracks abandonments
    },
    DAYS_SINCE_LAST_PURCHASE: {
      id: 'DAYS_SINCE_LAST_PURCHASE',
      label: 'Days Since Last Purchase',
      category: 'COMMERCE',
      type: 'CALCULATED_DAYS',
      dbField: 'lastPurchaseDate'
    },
    RTO_COUNT: {
      id: 'RTO_COUNT',
      label: 'RTO (Return to Origin) Count',
      category: 'COMMERCE',
      type: 'NUMBER',
      dbField: 'rtoCount'
    },
    EXCHANGE_REFUND_COUNT: {
      id: 'EXCHANGE_REFUND_COUNT',
      label: 'Exchange / Refund Count',
      category: 'COMMERCE',
      type: 'NUMBER',
      dbField: 'refundCount'
    },
    
    // ENGAGEMENT
    JUST_LANDED: {
      id: 'JUST_LANDED',
      label: 'Just Landed (New Contact, 0 Orders)',
      category: 'ENGAGEMENT',
      type: 'BOOLEAN',
      // Calculated dynamically: (ordersCount === 0 && inboundMessageCount === 1)
    },
    TOTAL_INTERACTIONS: {
      id: 'TOTAL_INTERACTIONS',
      label: 'Total Interactions',
      category: 'ENGAGEMENT',
      type: 'NUMBER',
      dbField: 'inboundMessageCount'
    },
    DAYS_SINCE_LAST_SEEN: {
      id: 'DAYS_SINCE_LAST_SEEN',
      label: 'Days Since Last Active',
      category: 'ENGAGEMENT',
      type: 'CALCULATED_DAYS',
      dbField: 'lastInteraction'
    },
    LEAD_SOURCE: {
      id: 'LEAD_SOURCE',
      label: 'Lead source (CRM)',
      category: 'ATTRIBUTION',
      type: 'STRING',
      dbField: 'source'
    },
    AD_CHANNEL: {
      id: 'AD_CHANNEL',
      label: 'Ad / discovery channel',
      category: 'ATTRIBUTION',
      type: 'STRING',
      dbField: 'adAttribution.source'
    },
    OPT_STATUS: {
      id: 'OPT_STATUS',
      label: 'WhatsApp marketing opt-in status',
      category: 'COMPLIANCE',
      type: 'STRING',
      dbField: 'optStatus',
      /** allowed: opted_in, opted_out, unknown */
    },
    LEAD_SCORE: {
      id: 'LEAD_SCORE',
      label: 'Lead score',
      category: 'ENGAGEMENT',
      type: 'NUMBER',
      dbField: 'leadScore'
    },
    HAS_TAG: {
      id: 'HAS_TAG',
      label: 'Has tag',
      category: 'ENGAGEMENT',
      type: 'STRING',
      dbField: 'tags'
    },
    OPT_IN_SOURCE: {
      id: 'OPT_IN_SOURCE',
      label: 'Opt-in source',
      category: 'COMPLIANCE',
      type: 'STRING',
      dbField: 'optInSource',
    },
    OPT_IN_TOOL: {
      id: 'OPT_IN_TOOL',
      label: 'Opt-in tool',
      category: 'COMPLIANCE',
      type: 'STRING',
      dbField: 'optInToolId',
    },
    PRIZE_WON: {
      id: 'PRIZE_WON',
      label: 'Prize won',
      category: 'COMPLIANCE',
      type: 'TEXT',
      dbField: 'capturedData.prizeLabel',
    },
    HAS_OPT_IN_COUPON: {
      id: 'HAS_OPT_IN_COUPON',
      label: 'Has opt-in coupon',
      category: 'COMPLIANCE',
      type: 'TEXT',
      dbField: 'capturedData.optInCouponCode',
    },
    OPT_IN_DATE: {
      id: 'OPT_IN_DATE',
      label: 'Opt-in date',
      category: 'COMPLIANCE',
      type: 'CALCULATED_DAYS',
      dbField: 'optInDate',
    },
    VISITOR_COUNT: {
      id: 'VISITOR_COUNT',
      label: 'Store visit count',
      category: 'COMPLIANCE',
      type: 'NUMBER',
      dbField: 'visitorVisitCount',
    },
  },
  FREQUENCY_OPERATORS: [
    { value: 'atleast_once', label: 'At least once' },
    { value: 'zero_times', label: 'Zero times' },
    { value: 'atleast_x', label: 'At least X times' },
    { value: 'exactly_x', label: 'Exactly X times' },
    { value: 'atmost_x', label: 'At most X times' }
  ],
  OPERATORS: {
    NUMBER: [
      { value: '>=', label: 'Greater than or equal to' },
      { value: '<=', label: 'Less than or equal to' },
      { value: '===', label: 'Exactly equals' }
    ],
    BOOLEAN: [
      { value: '===', label: 'Is' }
    ],
    CALCULATED_DAYS: [
      { value: '<=', label: 'Less than X days ago' },
      { value: '>=', label: 'More than X days ago' }
    ],
    STRING: [
      { value: '===', label: 'Equals' },
      { value: '!==', label: 'Does not equal' },
    ],
    TEXT: [
      { value: 'equals', label: 'Equals' },
      { value: 'contains', label: 'Contains' },
    ],
  }
};

module.exports = TRACKABLE_ASSETS;
