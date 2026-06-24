'use strict';

const { CLASSIFICATIONS } = require('./storyClassifier');

function detectBottleneck(funnel) {
  const views = Number(funnel?.views) || 0;
  const atc = Number(funnel?.addToCart) || 0;
  const checkout = Number(funnel?.checkout) || 0;
  const purchase = Number(funnel?.purchase) || 0;

  if (views <= 0) return null;

  const viewToCartDrop = views > 0 ? 1 - atc / views : 0;
  const cartToCheckoutDrop = atc > 0 ? 1 - checkout / atc : 0;
  const checkoutToPurchaseDrop = checkout > 0 ? 1 - purchase / checkout : 0;

  if (viewToCartDrop > 0.9) return 'product_page';
  if (cartToCheckoutDrop > 0.8) return 'cart';
  if (checkoutToPurchaseDrop > 0.8) return 'checkout';
  if (atc > 0 && purchase === 0) return 'checkout';
  return null;
}

const BOTTLENECK_LABEL = {
  product_page: 'product page',
  cart: 'cart UX',
  checkout: 'checkout flow',
};

function formatInr(amount) {
  const n = Math.round(Number(amount) || 0);
  return `₹${n.toLocaleString('en-IN')}`;
}

function buildProductNarrative({
  product,
  stats,
  classification,
  funnel,
  velocity,
  days,
  retargetableCount,
  avgOrderValue,
}) {
  const views = Number(stats?.views) || 0;
  const carts = Number(stats?.addToCarts) || 0;
  const purchases = Number(stats?.purchases) || 0;
  const revenue = Number(stats?.revenue) || 0;
  const viewsEstimated = Boolean(stats?.viewsEstimated);
  const bottleneck = detectBottleneck(funnel);
  const bottleneckLabel = BOTTLENECK_LABEL[bottleneck] || 'conversion';
  const title = product?.title || 'this product';

  if (classification === CLASSIFICATIONS.INSUFFICIENT_DATA) {
    if (carts > 0 && purchases === 0) {
      return `Cart interest detected (${carts} adds) but no purchase yet — check your product page and pricing.`;
    }
    return `Partial data only — install pixel on product pages to track views and conversion.`;
  }

  if (classification === CLASSIFICATIONS.NO_ACTIVITY) {
    return `No recent activity — consider featuring elsewhere or removing from collection.`;
  }

  if (viewsEstimated && purchases > 0) {
    if (classification === CLASSIFICATIONS.WINNING) {
      return `${formatInr(revenue)} revenue from ${purchases} orders — your best seller. Install pixel to track where buyers come from.`;
    }
    if (classification === CLASSIFICATIONS.DYING) {
      return `Only ${purchases} order${purchases === 1 ? '' : 's'} at ${formatInr(revenue)}. Consider bundling or running a promotion.`;
    }
    return `${purchases} sale${purchases === 1 ? '' : 's'} (${formatInr(revenue)}) without view tracking — install pixel for funnel insights.`;
  }

  if (classification === CLASSIFICATIONS.STALLED && views >= 50 && purchases === 0) {
    return `${views} views but 0 sales — your ${bottleneckLabel} is the bottleneck.`;
  }

  if (classification === CLASSIFICATIONS.RISING && (velocity?.viewVelocity || 0) >= 2) {
    const x = (velocity.viewVelocity || 2).toFixed(1).replace(/\.0$/, '');
    return `Views up ${x}× this week — momentum is building. Feature this product while interest is high.`;
  }

  if (classification === CLASSIFICATIONS.WINNING) {
    if (retargetableCount >= 100) {
      const recovery = retargetableCount * (avgOrderValue || 500) * 0.15;
      return `${formatInr(revenue)} from ${purchases} orders. ${retargetableCount} cart abandoners could recover ~${formatInr(recovery)}.`;
    }
    if (views > 0 && purchases > 0) {
      const conv = ((purchases / views) * 100).toFixed(1);
      return `${views} views → ${carts} carts → ${purchases} sales (${conv}% conversion). Checkout converts — drive more traffic.`;
    }
    return `${formatInr(revenue)} from ${purchases} orders — top performer in this period.`;
  }

  if (classification === CLASSIFICATIONS.DYING) {
    return `Traffic or sales declining — review pricing, photos, and collection placement.`;
  }

  if (views > 0 && purchases > 0) {
    const conv = ((purchases / views) * 100).toFixed(1);
    return `${views} views → ${carts} carts → ${purchases} sales (${conv}% conversion).`;
  }

  if (purchases >= 1) {
    return `${formatInr(revenue)} from ${purchases} order${purchases === 1 ? '' : 's'} — steady performer.`;
  }

  return `Building signal — check back after more store traffic.`;
}

function buildSitewideLeakDiagnosis(drops) {
  if (!drops?.length) {
    return {
      stage: null,
      dropPercent: 0,
      suggestion: 'Install the storefront pixel to see where your funnel leaks.',
    };
  }
  const worst = [...drops].sort((a, b) => (b.dropPercent || 0) - (a.dropPercent || 0))[0];
  const suggestions = {
    'visitors→productViews': 'Drive more product page visits — try homepage featuring or Meta prospecting.',
    'productViews→addToCarts': 'Your biggest leak is product page → cart. Review top product pages for trust signals.',
    'addToCarts→checkouts': 'Cart → checkout drop is high. Simplify cart UX and shipping transparency.',
    'checkouts→purchases': 'Checkout abandonment is high. Review payment options and COD friction.',
  };
  const key = `${worst.from}→${worst.to}`;
  return {
    stage: key,
    dropPercent: worst.dropPercent || 0,
    suggestion: suggestions[key] || 'Review your storefront funnel for friction.',
  };
}

function buildComparisonInsights(products) {
  if (!products || products.length < 2) return [];
  const insights = [];
  const sortedViews = [...products].sort((a, b) => (b.stats?.views || 0) - (a.stats?.views || 0));
  const sortedConv = [...products].sort((a, b) => {
    const ca = (a.stats?.views || 0) > 0 ? (a.stats?.purchases || 0) / a.stats.views : 0;
    const cb = (b.stats?.views || 0) > 0 ? (b.stats?.purchases || 0) / b.stats.views : 0;
    return cb - ca;
  });

  if (sortedViews[0] && sortedConv[0] && sortedViews[0].productId !== sortedConv[0].productId) {
    const a = sortedViews[0];
    const b = sortedConv[0];
    const viewRatio =
      (b.stats?.views || 0) > 0
        ? ((a.stats?.views || 0) / b.stats.views).toFixed(1)
        : 'more';
    const convA = (a.stats?.views || 0) > 0 ? (a.stats?.purchases || 0) / a.stats.views : 0;
    const convB = (b.stats?.views || 0) > 0 ? (b.stats?.purchases || 0) / b.stats.views : 0;
    const convRatio = convB > 0 ? (convA / convB).toFixed(1) : 'better';
    insights.push(
      `${a.title} has ${viewRatio}x the views but ${b.title} converts ${convRatio}x better`
    );
  }

  const rising = products.find((p) => p.classification === CLASSIFICATIONS.RISING);
  if (rising) {
    const highAbandon = [...products].sort(
      (a, b) => (b.retargetableAudience?.cartAbandoners || 0) - (a.retargetableAudience?.cartAbandoners || 0)
    )[0];
    if (highAbandon && highAbandon.productId === rising.productId) {
      insights.push(`${rising.title} is rising fast but has the highest cart abandonment`);
    }
  }

  return insights.slice(0, 3);
}

module.exports = {
  detectBottleneck,
  buildProductNarrative,
  buildSitewideLeakDiagnosis,
  buildComparisonInsights,
};
