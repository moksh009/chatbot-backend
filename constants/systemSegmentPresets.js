'use strict';

/** BiteSpeed-style live segment presets — seeded on first segment list load. */

const PROPERTY_RULE = (fields) => ({ type: 'rule', ruleKind: 'property', ...fields });

const SYSTEM_SEGMENT_PRESETS = [
  {
    presetKey: 'all_customers',
    name: 'All customers',
    description: 'Everyone in your WhatsApp + Shopify contact list.',
    conditions: [PROPERTY_RULE({ assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 0 })],
  },
  {
    presetKey: 'purchased_once',
    name: 'Purchased at least once',
    description: 'One or more completed orders.',
    conditions: [PROPERTY_RULE({ assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 1, frequency: 'atleast_once' })],
  },
  {
    presetKey: 'never_purchased',
    name: "Haven't purchased",
    description: 'Zero completed orders — good for win-back nudges.',
    conditions: [PROPERTY_RULE({ assetId: 'TOTAL_ORDERS', operator: '===', targetValue: 0, frequency: 'zero_times' })],
  },
  {
    presetKey: 'orders_eq_1',
    name: 'Exactly 1 order',
    description: 'First-time buyers — ideal for second-purchase campaigns.',
    conditions: [PROPERTY_RULE({ assetId: 'TOTAL_ORDERS', operator: '===', targetValue: 1, frequency: 'exactly_x' })],
  },
  {
    presetKey: 'purchased_more_than_once',
    name: 'Repeat buyers (2+ orders)',
    description: 'Loyal customers who came back.',
    conditions: [PROPERTY_RULE({ assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 2, frequency: 'atleast_x' })],
  },
  {
    presetKey: 'abandoned_cart',
    name: 'Abandoned cart',
    description: 'Open cart not recovered — pair with cart recovery messages.',
    conditions: [PROPERTY_RULE({ assetId: 'CART_STATUS', operator: '===', targetValue: 'abandoned' })],
  },
  {
    presetKey: 'checkout_started_no_order',
    name: 'Checkout started, no order',
    description: 'Started checkout at least once but order count is zero.',
    conditionTree: {
      type: 'group',
      operator: 'AND',
      children: [
        PROPERTY_RULE({ assetId: 'CHECKOUTS_STARTED', operator: '>=', targetValue: 1, frequency: 'atleast_once' }),
        PROPERTY_RULE({ assetId: 'TOTAL_ORDERS', operator: '===', targetValue: 0, frequency: 'zero_times' }),
      ],
    },
  },
  {
    presetKey: 'ordered_last_90d',
    name: 'Ordered in last 90 days',
    description: 'Recent buyers — upsell and replenishment.',
    conditions: [PROPERTY_RULE({ assetId: 'DAYS_SINCE_LAST_PURCHASE', operator: '<=', targetValue: 90 })],
  },
  {
    presetKey: 'not_ordered_90d',
    name: 'No order in 90 days',
    description: 'Inactive buyers including never purchased.',
    conditionTree: {
      type: 'group',
      operator: 'OR',
      children: [
        PROPERTY_RULE({ assetId: 'DAYS_SINCE_LAST_PURCHASE', operator: '>=', targetValue: 90 }),
        PROPERTY_RULE({ assetId: 'TOTAL_ORDERS', operator: '===', targetValue: 0, frequency: 'zero_times' }),
      ],
    },
  },
  {
    presetKey: 'opted_in_whatsapp',
    name: 'WhatsApp opted in',
    description: 'Marketing consent granted — safe for broadcasts.',
    conditions: [PROPERTY_RULE({ assetId: 'OPT_STATUS', operator: '===', targetValue: 'opted_in' })],
  },
  {
    presetKey: 'high_ltv',
    name: 'High LTV (₹5,000+)',
    description: 'Top spenders for VIP offers.',
    conditions: [PROPERTY_RULE({ assetId: 'LTV', operator: '>=', targetValue: 5000 })],
  },
  {
    presetKey: 'just_landed',
    name: 'Just landed (new contact)',
    description: 'New WhatsApp contact with no orders yet.',
    conditions: [PROPERTY_RULE({ assetId: 'JUST_LANDED', operator: '===', targetValue: true })],
  },
  {
    presetKey: 'optin_subscribers_30d',
    name: 'Recent opt-in subscribers',
    description: 'Opted in via website tools in the last 30 days.',
    conditions: [PROPERTY_RULE({ assetId: 'OPT_IN_DATE', operator: '<=', targetValue: 30 })],
  },
  {
    presetKey: 'spin_wheel_subscribers',
    name: 'Spin wheel subscribers',
    description: 'Leads captured via the spin wheel opt-in tool.',
    conditions: [PROPERTY_RULE({ assetId: 'OPT_IN_SOURCE', operator: '===', targetValue: 'spin_wheel' })],
  },
  {
    presetKey: 'prize_winners',
    name: 'Prize winners',
    description: 'Contacts who won a prize from spin wheel or mystery discount.',
    conditions: [PROPERTY_RULE({ assetId: 'PRIZE_WON', operator: 'is_set' })],
  },
  {
    presetKey: 'optin_no_order',
    name: 'Opted in, not ordered yet',
    description: 'Website opt-in leads who have not placed an order — prime for nurture campaigns.',
    conditionTree: {
      type: 'group',
      operator: 'AND',
      children: [
        PROPERTY_RULE({ assetId: 'OPT_IN_DATE', operator: '<=', targetValue: 365 }),
        PROPERTY_RULE({ assetId: 'TOTAL_ORDERS', operator: '===', targetValue: 0, frequency: 'zero_times' }),
      ],
    },
  },
  {
    presetKey: 'optin_converted',
    name: 'Opted in then ordered',
    description: 'Contacts who opted in via website tools and later purchased.',
    conditionTree: {
      type: 'group',
      operator: 'AND',
      children: [
        PROPERTY_RULE({ assetId: 'OPT_IN_DATE', operator: '<=', targetValue: 365 }),
        PROPERTY_RULE({ assetId: 'TOTAL_ORDERS', operator: '>=', targetValue: 1, frequency: 'atleast_once' }),
      ],
    },
  },
];

module.exports = { SYSTEM_SEGMENT_PRESETS };
