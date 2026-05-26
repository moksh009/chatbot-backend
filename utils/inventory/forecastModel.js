'use strict';

/**
 * Confidence-aware demand forecast (pure functions).
 */

function sumUnitsInWindow(orders, sku, daysBack, daysLen = daysBack) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - daysLen);

  let units = 0;
  let orderCount = 0;
  for (const o of orders) {
    const t = new Date(o.createdAt);
    if (t < start || t > end) continue;
    let lineUnits = 0;
    for (const item of o.items || []) {
      if (sku && item.sku !== sku) continue;
      lineUnits += Number(item.quantity) || 1;
    }
    if (lineUnits > 0) {
      units += lineUnits;
      orderCount += 1;
    }
  }
  const days = Math.max(1, daysLen);
  return { velocity: units / days, units, orderCount };
}

function computeVelocityBlend(orders, sku) {
  const v7 = sumUnitsInWindow(orders, sku, 7, 7);
  const v30 = sumUnitsInWindow(orders, sku, 30, 30);
  const v90 = sumUnitsInWindow(orders, sku, 90, 90);

  const firstOrder = orders.length
    ? orders.reduce((a, o) => (new Date(o.createdAt) < new Date(a.createdAt) ? o : a))
    : null;
  const historyDays = firstOrder
    ? (Date.now() - new Date(firstOrder.createdAt).getTime()) / (24 * 60 * 60 * 1000)
    : 0;

  let velocity = v7.velocity;
  if (historyDays >= 7 && historyDays < 30) {
    velocity = v7.velocity * 0.6 + v30.velocity * 0.4;
  } else if (historyDays >= 30 && historyDays < 90) {
    velocity = v30.velocity;
  } else if (historyDays >= 90) {
    velocity = v30.velocity * 0.7 + v90.velocity * 0.3;
  }

  return {
    velocity: Number(velocity.toFixed(4)),
    velocity_7d: v7.velocity,
    velocity_30d: v30.velocity,
    velocity_90d: v90.velocity,
    historyDays: Math.floor(historyDays),
    orderCount30d: v30.orderCount,
  };
}

function velocityVariance(orders, sku) {
  const daily = {};
  for (const o of orders) {
    const day = new Date(o.createdAt).toISOString().slice(0, 10);
    for (const item of o.items || []) {
      if (sku && item.sku !== sku) continue;
      daily[day] = (daily[day] || 0) + (Number(item.quantity) || 1);
    }
  }
  const vals = Object.values(daily);
  if (vals.length < 3) return 1;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
  return mean > 0 ? Math.sqrt(variance) / mean : 1;
}

function computeConfidence(orders, sku, blend) {
  let score = 20;
  if (blend.historyDays >= 7) score += 15;
  if (blend.historyDays >= 30) score += 20;
  if (blend.historyDays >= 90) score += 15;
  if (blend.orderCount30d >= 5) score += 10;
  if (blend.orderCount30d >= 20) score += 10;

  const cv = velocityVariance(orders, sku);
  if (cv < 0.5) score += 15;
  else if (cv < 1) score += 8;
  else score -= 10;

  const trend = detectTrend(orders, sku);
  if (trend.trend === 'up' && trend.magnitude > 2) score -= 8;

  const channels = new Set();
  for (const o of orders) {
    for (const item of o.items || []) {
      if (sku && item.sku !== sku) continue;
      channels.add(o.source === 'amazon' ? 'amazon' : 'shopify');
    }
  }
  if (channels.size >= 2) score += 10;

  score = Math.max(0, Math.min(100, score));
  const band = score <= 33 ? 'low' : score <= 66 ? 'medium' : 'high';
  return { score, band };
}

function confidencePenalty(band) {
  if (band === 'high') return 0;
  if (band === 'medium') return 0.1;
  return 0.25;
}

function computeDepletion(stock, velocity, confidenceBand) {
  if (!velocity || velocity <= 0) {
    return { days: null, range: null, label: 'No recent sales' };
  }
  const base = stock / velocity;
  const penalty = confidencePenalty(confidenceBand);
  const adjusted = base * (1 - penalty);
  const low = Math.max(0, Math.floor(adjusted * 0.85));
  const high = Math.ceil(adjusted * 1.15);
  return {
    days: Math.round(adjusted),
    range: [low, high],
    label: `${Math.round(adjusted)} days (${confidenceBand} confidence)`,
  };
}

function detectTrend(orders, sku) {
  const recent = sumUnitsInWindow(orders, sku, 7, 7);
  const prior = sumUnitsInWindow(orders, sku, 30, 23);
  const priorStart = new Date();
  priorStart.setDate(priorStart.getDate() - 30);
  let priorUnits = 0;
  for (const o of orders) {
    const t = new Date(o.createdAt);
    if (t < priorStart) continue;
    if (t >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) continue;
    for (const item of o.items || []) {
      if (sku && item.sku !== sku) continue;
      priorUnits += Number(item.quantity) || 1;
    }
  }
  const priorVel = priorUnits / 23;
  if (priorVel <= 0 && recent.velocity > 0) {
    return { trend: 'up', magnitude: recent.velocity };
  }
  if (priorVel <= 0) return { trend: 'flat', magnitude: 0 };
  const ratio = recent.velocity / priorVel;
  if (ratio >= 1.5) return { trend: 'up', magnitude: ratio };
  if (ratio <= 0.6) return { trend: 'down', magnitude: ratio };
  return { trend: 'flat', magnitude: ratio };
}

function buildSkuForecast(orders, sku, stock) {
  const blend = computeVelocityBlend(orders, sku);
  const confidence = computeConfidence(orders, sku, blend);
  const depletion = computeDepletion(stock, blend.velocity, confidence.band);
  const trend = detectTrend(orders, sku);
  return { ...blend, confidence, depletion, trend };
}

module.exports = {
  computeVelocityBlend,
  computeConfidence,
  computeDepletion,
  detectTrend,
  buildSkuForecast,
  confidencePenalty,
};
