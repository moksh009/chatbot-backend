'use strict';

/**
 * Canonical post-purchase journey playbooks (Phase 9).
 */
const PLAYBOOK_TEMPLATES = [
  {
    playbookKey: 'review_request',
    name: 'Review Request',
    journeyTrigger: 'order_fulfilled',
    journeyPolicies: {
      repeatPerCustomer: 'never',
      minOrderValue: null,
      productInclusions: null,
      windowDays: 1,
    },
    steps: [
      {
        type: 'whatsapp',
        templateName: 'review_request_v1',
        content:
          'Hope you loved your order! Would you share a quick review? Tap a star below.',
        delayValue: 1,
        delayUnit: 'd',
      },
    ],
  },
  {
    playbookKey: 'loyalty_enrollment',
    name: 'Loyalty Enrollment',
    journeyTrigger: 'order_fulfilled',
    journeyPolicies: {
      repeatPerCustomer: 'never',
      minOrderValue: null,
      productInclusions: null,
      windowDays: 3,
    },
    steps: [
      {
        type: 'whatsapp',
        templateName: 'loyalty_enroll_v1',
        content: 'You earned loyalty points on your order! Tap to view your wallet.',
        delayValue: 3,
        delayUnit: 'd',
      },
    ],
  },
  {
    playbookKey: 'repurchase_nudge',
    name: 'Repurchase Nudge',
    journeyTrigger: 'order_delivered',
    journeyPolicies: {
      repeatPerCustomer: 'once_per_month',
      minOrderValue: null,
      productInclusions: null,
      windowDays: 30,
    },
    steps: [
      {
        type: 'whatsapp',
        templateName: 'repurchase_nudge_v1',
        content: 'Time to restock? Your last order is due for a refill — order again in one tap.',
        delayValue: 30,
        delayUnit: 'd',
      },
    ],
  },
  {
    playbookKey: 'win_back',
    name: 'Win-back',
    journeyTrigger: 'win_back_inactive',
    journeyPolicies: {
      repeatPerCustomer: 'once_per_year',
      minOrderValue: null,
      productInclusions: null,
      windowDays: 0,
    },
    steps: [
      {
        type: 'whatsapp',
        templateName: 'win_back_v1',
        content: 'We miss you! Here is 15% off your next order — use code COMEBACK15.',
        delayValue: 0,
        delayUnit: 'd',
      },
    ],
  },
];

module.exports = { PLAYBOOK_TEMPLATES };
