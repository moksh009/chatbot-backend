'use strict';

const { CLASSIFICATIONS } = require('./storyClassifier');

function buildRealtimeAlerts(products, audiences, insightsState = {}) {
  const alerts = [];
  const rising = (products || []).filter((p) => p.classification === CLASSIFICATIONS.RISING);
  if (rising.length > 0) {
    alerts.push({
      id: 'rising',
      type: 'rising',
      message: `${rising[0].title} is heating up — views surging this week`,
      link: '/commerce-hub?tab=product_insights&section=overview',
    });
  }

  const cartTier = audiences?.cartAbandoners?.tier;
  const prevTier = insightsState?.lastAudienceTier;
  if (prevTier === 'build' && cartTier === 'minimum') {
    alerts.push({
      id: 'audience_ready',
      type: 'audience_ready',
      message: `Your cart abandoner audience (${audiences.cartAbandoners.count}) is now Meta-ready (100+)`,
      link: '/commerce-hub?tab=product_insights&section=audiences',
    });
  }

  const stalled = (products || []).filter((p) => p.classification === CLASSIFICATIONS.STALLED);
  if (stalled.length > 0 && rising.length === 0) {
    alerts.push({
      id: 'stalled',
      type: 'stalled',
      message: `${stalled[0].title} has interest but zero sales — check funnel`,
      link: '/commerce-hub?tab=product_insights&section=overview',
    });
  }

  return alerts.slice(0, 3);
}

module.exports = { buildRealtimeAlerts };
