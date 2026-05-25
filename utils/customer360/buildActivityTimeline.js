'use strict';

/**
 * Merge lead activityLog, orders, messages, campaigns, sequences, and consent into one timeline.
 * @returns {Array<{ eventName: string, action?: string, timestamp: Date|string, source?: string, meta?: object }>}
 */
function buildActivityTimeline({
  lead = {},
  orders = [],
  messages = [],
  marketingLogs = [],
  sequences = [],
  conversation = null,
}) {
  const events = [];

  const push = (eventName, timestamp, extra = {}) => {
    if (!timestamp) return;
    const ts = new Date(timestamp);
    if (Number.isNaN(ts.getTime())) return;
    events.push({ eventName, timestamp: ts, ...extra });
  };

  for (const entry of lead.activityLog || []) {
    push(entry.action || entry.eventName || 'Activity', entry.timestamp, {
      action: entry.action,
      source: 'activity_log',
      meta: entry.details ? { details: entry.details } : undefined,
    });
  }

  for (const o of orders) {
    push('Order placed', o.createdAt || o.orderDate, {
      action: 'order_placed',
      source: 'order',
      meta: { orderId: o.orderId || o._id, total: o.totalPrice || o.total },
    });
  }

  for (const m of messages) {
    const dir = m.direction === 'outbound' ? 'Outbound' : 'Inbound';
    const preview = (m.content || '').slice(0, 80);
    push(`${dir} message`, m.timestamp, {
      action: 'message',
      source: 'conversation',
      meta: { preview, sentiment: m.sentimentLabel },
    });
  }

  for (const log of marketingLogs) {
    const name = log.campaignId?.name || 'Campaign';
    const status = log.status || 'sent';
    push(`Campaign: ${name} (${status})`, log.sentAt || log.createdAt, {
      action: 'campaign_message',
      source: 'campaign',
      meta: { campaignId: log.campaignId?._id || log.campaignId },
    });
  }

  for (const s of sequences) {
    push(`Sequence: ${s.name || 'Follow-up'} (${s.status || 'active'})`, s.createdAt || s.updatedAt, {
      action: 'sequence',
      source: 'sequence',
      meta: { sequenceId: s._id, step: s.currentStepIndex },
    });
  }

  if (conversation?.createdAt) {
    push('Conversation started', conversation.createdAt, {
      action: 'conversation_started',
      source: 'conversation',
    });
  }

  if (lead.createdAt) {
    push('Lead created', lead.createdAt, { action: 'lead_created', source: 'lead' });
  }

  const cc = lead.channelConsent || {};
  for (const channel of ['whatsapp', 'email', 'instagram']) {
    const ch = cc[channel];
    if (!ch) continue;
    if (ch.optInAt) {
      push(`${channel} opt-in`, ch.optInAt, {
        action: 'opt_in',
        source: 'consent',
        meta: { channel, status: ch.status, source: ch.source },
      });
    }
    if (ch.optOutAt) {
      push(`${channel} opt-out`, ch.optOutAt, {
        action: 'opt_out',
        source: 'consent',
        meta: { channel, status: ch.status, reason: ch.reason },
      });
    }
  }

  if (lead.optInDate && !cc.whatsapp?.optInAt && !cc.email?.optInAt) {
    push('Marketing opt-in', lead.optInDate, {
      action: 'opt_in',
      source: 'consent',
      meta: { source: lead.optInSource },
    });
  }
  if (lead.optOutDate) {
    push('Marketing opt-out', lead.optOutDate, {
      action: 'opt_out',
      source: 'consent',
      meta: { source: lead.optOutSource, keyword: lead.optOutKeyword },
    });
  }

  if (lead.cartAbandonedAt) {
    push('Cart abandoned', lead.cartAbandonedAt, { action: 'cart_abandoned', source: 'cart' });
  }
  if (lead.abandonedCartRecoveredAt) {
    push('Cart recovered', lead.abandonedCartRecoveredAt, { action: 'cart_recovered', source: 'cart' });
  }

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const seen = new Set();
  return events.filter((e) => {
    const key = `${e.eventName}|${new Date(e.timestamp).toISOString()}|${e.action || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { buildActivityTimeline };
