'use strict';

const PixelEvent = require('../../../models/PixelEvent');

const CLASSIFICATIONS = {
  WINNING: 'WINNING',
  RISING: 'RISING',
  STEADY: 'STEADY',
  STALLED: 'STALLED',
  DYING: 'DYING',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  NO_ACTIVITY: 'NO_ACTIVITY',
};

function classifyProduct({
  stats,
  velocity,
  daysOfData,
  daysSinceLastEvent,
  medianTopRevenue = 0,
}) {
  const views = Number(stats?.views) || 0;
  const purchases = Number(stats?.purchases) || 0;
  const revenue = Number(stats?.revenue) || 0;
  const cartAdds = Number(stats?.addToCarts) || 0;
  const viewVelocity = Number(velocity?.viewVelocity) || 0;
  const viewsEstimated = Boolean(stats?.viewsEstimated);
  const hasTrackedViews = views > 0 && !viewsEstimated;

  if (views === 0 && !viewsEstimated) {
    if (purchases === 0 && cartAdds === 0) {
      return CLASSIFICATIONS.NO_ACTIVITY;
    }
    if (purchases === 0 && cartAdds > 0) {
      return CLASSIFICATIONS.INSUFFICIENT_DATA;
    }
    if (purchases >= 3 && revenue >= medianTopRevenue && medianTopRevenue > 0) {
      return CLASSIFICATIONS.WINNING;
    }
    if (daysSinceLastEvent != null && daysSinceLastEvent > 14) {
      return CLASSIFICATIONS.DYING;
    }
    if (purchases >= 1) {
      return revenue >= medianTopRevenue && medianTopRevenue > 0
        ? CLASSIFICATIONS.WINNING
        : CLASSIFICATIONS.STEADY;
    }
  }

  if (daysOfData < 7) {
    return CLASSIFICATIONS.INSUFFICIENT_DATA;
  }

  if (hasTrackedViews === false && purchases === 0 && cartAdds === 0) {
    if (daysSinceLastEvent == null || daysSinceLastEvent > 14) {
      return CLASSIFICATIONS.NO_ACTIVITY;
    }
    return CLASSIFICATIONS.NO_ACTIVITY;
  }

  const conversionRate = hasTrackedViews ? purchases / views : 0;

  if (purchases >= 3 && revenue >= medianTopRevenue && (hasTrackedViews ? conversionRate >= 0.01 : true)) {
    return CLASSIFICATIONS.WINNING;
  }

  if (viewVelocity >= 2 && views >= 20) {
    return CLASSIFICATIONS.RISING;
  }

  if (daysSinceLastEvent != null && daysSinceLastEvent > 14) {
    return CLASSIFICATIONS.DYING;
  }

  if (viewVelocity <= 0.3 && views >= 10) {
    return CLASSIFICATIONS.DYING;
  }

  if (views >= 50 && purchases === 0) {
    return CLASSIFICATIONS.STALLED;
  }

  if (viewVelocity >= 0.7 && viewVelocity <= 1.5 && purchases >= 1) {
    return CLASSIFICATIONS.STEADY;
  }

  if (purchases >= 1) {
    return CLASSIFICATIONS.STEADY;
  }

  if (views >= 20) {
    return CLASSIFICATIONS.STALLED;
  }

  return CLASSIFICATIONS.STEADY;
}

function medianRevenueOfTop(products, n = 10) {
  const revenues = (products || [])
    .map((p) => Number(p.revenue) || 0)
    .filter((r) => r > 0)
    .sort((a, b) => b - a)
    .slice(0, n);
  if (!revenues.length) return 0;
  const mid = Math.floor(revenues.length / 2);
  return revenues.length % 2 ? revenues[mid] : (revenues[mid - 1] + revenues[mid]) / 2;
}

async function getDaysSinceLastProductEvent(clientId, productId) {
  const last = await PixelEvent.findOne({
    clientId,
    $or: [
      { 'metadata.product.productId': productId },
      { 'metadata.product.id': productId },
      { url: new RegExp(`/products/${productId.replace(/^handle:/, '')}`, 'i') },
    ],
  })
    .sort({ timestamp: -1 })
    .select('timestamp')
    .lean();

  if (!last?.timestamp) return null;
  const diff = Date.now() - new Date(last.timestamp).getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

module.exports = {
  CLASSIFICATIONS,
  classifyProduct,
  medianRevenueOfTop,
  getDaysSinceLastProductEvent,
};
