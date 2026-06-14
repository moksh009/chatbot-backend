'use strict';

const STATUSES = ['paid', 'shipped', 'delivered', 'cancelled'];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Reasons that are setup gaps, not Meta send failures merchants should panic about. */
const NON_ACTIONABLE_FAILURE_REASONS = new Set([
  'no_template_configured',
  'no_mapping',
  'auto_shipped_disabled',
]);

function isActionableFailureEntry(entry) {
  if (!entry || entry.success !== false) return false;
  const reason = String(entry.reason || '').toLowerCase().trim();
  if (NON_ACTIONABLE_FAILURE_REASONS.has(reason)) return false;
  const channel = String(entry.channel || '').toLowerCase();
  if (channel === 'none') return false;
  if (entry.templateName) return true;
  return channel === 'template' || channel === 'text' || channel === 'automation';
}

/**
 * Aggregate whatsappActivityLog across orders for SAC status cards.
 * @param {Array<{ _id?: *, orderId?: string, orderNumber?: string, whatsappActivityLog?: object[] }>} orders
 * @param {{ now?: number }} [opts]
 */
function aggregateOrderStatusMetrics(orders, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const weekAgo = now - SEVEN_DAYS_MS;

  const byStatus = {};
  for (const s of STATUSES) {
    byStatus[s] = {
      count7d: 0,
      success7d: 0,
      failure7d: 0,
      lastSendAt: null,
      successRate: null,
    };
  }

  const failures = [];

  for (const order of orders || []) {
    const log = Array.isArray(order.whatsappActivityLog) ? order.whatsappActivityLog : [];
    for (const entry of log) {
      const ev = String(entry.event || '').toLowerCase();
      if (!STATUSES.includes(ev)) continue;
      const atMs = entry.at ? new Date(entry.at).getTime() : 0;
      if (!atMs || Number.isNaN(atMs)) continue;

      if (atMs >= weekAgo) {
        byStatus[ev].count7d += 1;
        if (entry.success) byStatus[ev].success7d += 1;
        else byStatus[ev].failure7d += 1;
      }

      if (entry.success) {
        const prev = byStatus[ev].lastSendAt ? new Date(byStatus[ev].lastSendAt).getTime() : 0;
        if (!prev || atMs > prev) byStatus[ev].lastSendAt = entry.at;
      }

      if (!entry.success && atMs >= weekAgo && isActionableFailureEntry(entry)) {
        failures.push({
          orderId: String(order._id || order.orderId || ''),
          orderNumber: order.orderNumber || order.orderId || '',
          event: ev,
          at: entry.at,
          templateName: entry.templateName || null,
          reason: entry.reason || null,
          source: entry.source || null,
          channel: entry.channel || null,
        });
      }
    }
  }

  for (const s of STATUSES) {
    const row = byStatus[s];
    const attempts = row.success7d + row.failure7d;
    row.successRate = attempts > 0 ? Math.round((row.success7d / attempts) * 100) : null;
  }

  failures.sort((a, b) => new Date(b.at) - new Date(a.at));

  return { byStatus, failures };
}

module.exports = {
  STATUSES,
  aggregateOrderStatusMetrics,
  isActionableFailureEntry,
  NON_ACTIONABLE_FAILURE_REASONS,
};
