'use strict';

const axios = require('axios');
const log = require('../core/logger')('MetaPricingAnalytics');
const {
  getEffectiveWhatsAppAccessToken,
  getEffectiveWhatsAppWabaId,
} = require('./clientWhatsAppCreds');

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v21.0';

/**
 * Fetch WABA pricing_analytics for current calendar month (Meta COST + VOLUME).
 * Returns null when WABA/token missing or API errors.
 */
async function fetchWabaPricingAnalytics(client, opts = {}) {
  const wabaId = getEffectiveWhatsAppWabaId(client);
  const token = getEffectiveWhatsAppAccessToken(client);
  if (!wabaId || !token) {
    return { ok: false, reason: 'missing_waba_or_token' };
  }

  const now = opts.now ? new Date(opts.now) : new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = Math.floor(monthStart.getTime() / 1000);
  const end = Math.floor(now.getTime() / 1000);

  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/pricing_analytics`;
    const res = await axios.get(url, {
      params: {
        access_token: token,
        start,
        end,
        granularity: 'MONTHLY',
        metric_types: ['COST', 'VOLUME'],
        dimensions: ['PRICING_CATEGORY', 'PRICING_TYPE'],
      },
      timeout: 15000,
    });

    const rows = res.data?.data || [];
    const byCategory = {};
    let totalCost = 0;
    let totalVolume = 0;

    for (const block of rows) {
      const points = block?.data_points || block?.data || [];
      for (const pt of points) {
        const cat = String(pt.pricing_category || pt.category || 'UNKNOWN').toUpperCase();
        const vol = Number(pt.volume || pt.message_count || 0);
        const cost = Number(pt.cost || pt.approximate_cost || 0);
        if (!byCategory[cat]) byCategory[cat] = { volume: 0, cost: 0 };
        byCategory[cat].volume += vol;
        byCategory[cat].cost += cost;
        totalVolume += vol;
        totalCost += cost;
      }
    }

    return {
      ok: true,
      source: 'meta_pricing_analytics',
      currency: 'INR',
      monthStart: monthStart.toISOString(),
      totalCostInr: Math.round(totalCost * 100) / 100,
      totalVolume,
      byCategory,
      rawRowCount: rows.length,
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.warn(`pricing_analytics failed for ${client.clientId}: ${msg}`);
    return { ok: false, reason: msg };
  }
}

module.exports = { fetchWabaPricingAnalytics };
