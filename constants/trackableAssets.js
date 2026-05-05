// Centralized Data Dictionary for Lead Scoring & Segmentation
const TRACKABLE_ASSETS = {
  CATEGORIES: {
    COMMERCE: 'Shopify / Commerce',
    ENGAGEMENT: 'WhatsApp / Engagement',
    ATTRIBUTION: 'Source & ads',
    COMPLIANCE: 'WhatsApp consent'
  },
  ASSETS: {
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
  },
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
      { value: '===', label: 'Equals' }
    ]
  }
};

module.exports = TRACKABLE_ASSETS;
