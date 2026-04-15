// Centralized Data Dictionary for Lead Scoring & Segmentation
const TRACKABLE_ASSETS = {
  CATEGORIES: {
    COMMERCE: 'Shopify / Commerce',
    ENGAGEMENT: 'WhatsApp / Engagement'
  },
  ASSETS: {
    // COMMERCE
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
    }
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
    ]
  }
};

module.exports = TRACKABLE_ASSETS;
