'use strict';

/**
 * UTILITY template slots for Winning Products digest notifications.
 * Submit through Meta Manager template pack when enabling production sends.
 */
const WINNING_PRODUCTS_DIGEST_SLOTS = [
  {
    slot: 'insights_daily_digest_v1',
    category: 'UTILITY',
    description: 'Daily top winners + rising/attention SKUs',
  },
  {
    slot: 'insights_weekly_digest_v1',
    category: 'UTILITY',
    description: 'Weekly winner, rising star, funnel leak, audience size',
  },
  {
    slot: 'insights_alert_rising_v1',
    category: 'UTILITY',
    description: 'Hot product velocity alert',
  },
  {
    slot: 'insights_alert_audience_ready_v1',
    category: 'UTILITY',
    description: 'Cart abandoner audience crossed Meta minimum (100)',
  },
];

module.exports = { WINNING_PRODUCTS_DIGEST_SLOTS };
