'use strict';

const moment = require('moment');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const Client = require('../models/Client');

const PRESETS = {
  today: () => ({ from: moment().startOf('day').toDate(), to: new Date() }),
  '7d': () => ({ from: moment().subtract(7, 'days').startOf('day').toDate(), to: new Date() }),
  '30d': () => ({ from: moment().subtract(30, 'days').startOf('day').toDate(), to: new Date() }),
  '60d': () => ({ from: moment().subtract(60, 'days').startOf('day').toDate(), to: new Date() }),
  '90d': () => ({ from: moment().subtract(90, 'days').startOf('day').toDate(), to: new Date() }),
};

function parseDateRange(query = {}) {
  const preset = String(query.preset || '').toLowerCase();
  if (preset && PRESETS[preset]) return { ...PRESETS[preset](), preset };

  const fromRaw = query.from || query.startDate;
  const toRaw = query.to || query.endDate;
  if (fromRaw && toRaw) {
    const from = moment(fromRaw).startOf('day').toDate();
    const to = moment(toRaw).endOf('day').toDate();
    if (from <= to) return { from, to, preset: 'custom' };
  }

  return { ...PRESETS['30d'](), preset: '30d' };
}

function getRecoverySchedule(niche = {}) {
  const delay1 = parseInt(niche.abandonedDelay1, 10) || 15;
  const delay2Hr = parseInt(niche.abandonedDelay2, 10) || 2;
  const delay3Hr = parseInt(niche.abandonedDelay3, 10) || 24;
  return [
    { step: 1, delayMinutes: delay1, label: `Followup 1` },
    { step: 2, delayMinutes: delay2Hr * 60, label: `Followup 2`, afterPrevious: true },
    { step: 3, delayMinutes: delay3Hr * 60, label: `Followup 3`, afterPrevious: true },
  ];
}

function stepSentAt(lead, stepNum) {
  const key = `cart_step_${stepNum}`;
  const logs = Array.isArray(lead.activityLog) ? lead.activityLog : [];
  const hit = logs.find((l) => l?.action === 'automation_nudge' && String(l?.details || '').includes(key));
  return hit?.timestamp ? new Date(hit.timestamp) : null;
}

function waMessagesSent(lead) {
  const step = Number(lead.recoveryStep || 0);
  if (step > 0) return true;
  const logs = Array.isArray(lead.activityLog) ? lead.activityLog : [];
  return logs.some(
    (l) =>
      l?.action === 'automation_nudge' &&
      /cart_step_|browse_abandon/.test(String(l?.details || ''))
  );
}

function abandonDate(lead) {
  return (
    lead.cartAbandonedAt ||
    lead.lastCartEventAt ||
    (lead.cartStatus === 'abandoned' ? lead.lastInteraction : null) ||
    lead.updatedAt ||
    lead.createdAt
  );
}

function normalizeItems(lead) {
  const snap = lead.cartSnapshot || {};
  const raw = Array.isArray(snap.items) ? snap.items : [];
  if (raw.length) {
    return raw.map((item, idx) => {
      const qty = Number(item.quantity || item.qty || 1) || 1;
      const price = Number(item.price ?? item.line_price ?? item.presentment_price ?? 0) || 0;
      const compare = Number(item.compare_at_price ?? item.original_price ?? item.compareAtPrice ?? 0) || 0;
      return {
        id: String(item.variant_id || item.id || idx),
        title: item.title || item.name || item.product_title || `Item ${idx + 1}`,
        quantity: qty,
        price,
        compareAtPrice: compare > price ? compare : null,
        image: item.image || item.image_url || null,
        lineTotal: price * qty,
      };
    });
  }
  const titles = Array.isArray(snap.titles) ? snap.titles : [];
  const total = Number(snap.total_price ?? snap.totalPrice ?? lead.cartValue ?? 0) || 0;
  if (!titles.length) return [];
  const each = titles.length ? total / titles.length : total;
  return titles.map((title, idx) => ({
    id: String(idx),
    title,
    quantity: 1,
    price: each,
    compareAtPrice: null,
    image: null,
    lineTotal: each,
  }));
}

function cartTotals(items, snap = {}) {
  const lineSum = items.reduce((s, i) => s + (i.lineTotal || 0), 0);
  const total =
    lineSum ||
    Number(snap.total_price ?? snap.totalPrice ?? 0) ||
    0;
  const compareSum = items.reduce(
    (s, i) => s + (i.compareAtPrice ? i.compareAtPrice * i.quantity : i.lineTotal),
    0
  );
  return {
    cartValue: total,
    compareAtValue: compareSum > total ? compareSum : null,
    currency: snap.currency || 'INR',
  };
}

function isRecoveredLead(lead) {
  return (
    lead.cartStatus === 'recovered' ||
    lead.cartStatus === 'purchased' ||
    lead.isOrderPlaced === true
  );
}

function isWaRecoveredLead(lead) {
  if (!isRecoveredLead(lead)) return false;
  return waMessagesSent(lead);
}

function buildFollowupStatus(lead, schedule, now = new Date()) {
  const abandonedAt = abandonDate(lead);
  if (!abandonedAt) {
    return { lines: [{ text: 'No abandon timestamp', tone: 'muted' }], schedule };
  }

  const step = Number(lead.recoveryStep || 0);
  const lines = [];
  let anchor = new Date(abandonedAt);

  for (const s of schedule) {
    const sentAt = stepSentAt(lead, s.step);
    if (step >= s.step || sentAt) {
      lines.push({ text: `${s.label} sent`, tone: 'sent' });
      anchor = sentAt || anchor;
      continue;
    }

    const dueAt = s.afterPrevious
      ? moment(anchor).add(s.delayMinutes, 'minutes')
      : moment(abandonedAt).add(s.delayMinutes, 'minutes');

    if (now >= dueAt.toDate()) {
      lines.push({ text: `${s.label} due now`, tone: 'due' });
    } else {
      const mins = Math.max(1, dueAt.diff(moment(now), 'minutes'));
      const human =
        mins >= 60 * 24
          ? `${Math.round(mins / (60 * 24))} day${mins >= 60 * 48 ? 's' : ''}`
          : mins >= 60
            ? `${Math.round(mins / 60)} hour${mins >= 120 ? 's' : ''}`
            : `${mins} minute${mins !== 1 ? 's' : ''}`;
      lines.push({ text: `${s.label} after ${human}`, tone: 'pending' });
    }
    break;
  }

  if (!lines.length) {
    lines.push({ text: 'Recovery complete', tone: 'muted' });
  }

  return { lines, schedule };
}

function recoveryStatusLabel(lead) {
  if (isWaRecoveredLead(lead)) return { key: 'whatsapp', label: 'Recovered via WhatsApp' };
  if (isRecoveredLead(lead)) return { key: 'organic', label: 'Recovered' };
  return { key: 'active', label: 'Active abandoned' };
}

function normalizePhoneKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function latestOrdersByPhone(clientId, phones = []) {
  const suffixes = [...new Set(phones.map(normalizePhoneKey).filter((p) => p.length >= 8))];
  if (!suffixes.length) return new Map();

  const orders = await Order.find({ clientId })
    .sort({ createdAt: -1 })
    .select('phone customerPhone financialStatus fulfillmentStatus status totalPrice amount createdAt')
    .limit(5000)
    .lean();

  const map = new Map();
  for (const o of orders) {
    const key = normalizePhoneKey(o.customerPhone || o.phone);
    if (!key || map.has(key)) continue;
    if (!suffixes.includes(key)) continue;
    map.set(key, o);
  }
  return map;
}

function orderStatusLabel(order, lead) {
  if (!order && !lead.isOrderPlaced) return { key: 'abandoned', label: 'Abandoned' };
  if (!order && lead.isOrderPlaced) return { key: 'ordered', label: 'Ordered' };

  const fin = String(order.financialStatus || '').toLowerCase();
  const ful = String(order.fulfillmentStatus || '').toLowerCase();
  const st = String(order.status || '').toLowerCase();

  if (fin === 'refunded' || st === 'refunded') return { key: 'refunded', label: 'Refunded' };
  if (ful === 'fulfilled' || st === 'delivered') return { key: 'delivered', label: 'Delivered' };
  if (ful === 'shipped' || st === 'shipped') return { key: 'shipped', label: 'Shipped' };
  if (fin === 'pending' || fin === 'partially_paid') return { key: 'pending', label: 'Pending order' };
  if (fin === 'paid') return { key: 'paid', label: 'Paid' };
  return { key: 'ordered', label: order.status || 'Ordered' };
}

function leadInAbandonWindow(lead, from, to) {
  const d = abandonDate(lead);
  if (!d) return false;
  const t = new Date(d).getTime();
  return t >= from.getTime() && t <= to.getTime();
}

function isAbandonCandidate(lead) {
  return (
    (lead.addToCartCount || 0) > 0 ||
    ['abandoned', 'recovered', 'active'].includes(lead.cartStatus) ||
    (lead.cartSnapshot?.items?.length || 0) > 0 ||
    (lead.cartSnapshot?.titles?.length || 0) > 0
  );
}

async function buildAbandonedCartWorkspace(clientId, query = {}) {
  const { from, to, preset } = parseDateRange(query);
  const client = await Client.findOne({ clientId }).select('nicheData timezone').lean();
  const schedule = getRecoverySchedule(client?.nicheData || {});

  const leads = await AdLead.find({
    clientId,
    $or: [
      { cartAbandonedAt: { $gte: from, $lte: to } },
      {
        cartStatus: { $in: ['abandoned', 'recovered', 'active'] },
        updatedAt: { $gte: from, $lte: to },
        addToCartCount: { $gt: 0 },
      },
      {
        addToCartCount: { $gt: 0 },
        lastInteraction: { $gte: from, $lte: to },
      },
    ],
  })
    .select(
      'phoneNumber name email cartStatus cartSnapshot cartValue cartAbandonedAt lastCartEventAt lastInteraction createdAt updatedAt isOrderPlaced recoveryStep recoveryStartedAt abandonedCartRecoveredAt activityLog addToCartCount checkoutInitiatedCount'
    )
    .limit(8000)
    .lean();

  const filtered = leads.filter((l) => isAbandonCandidate(l) && leadInAbandonWindow(l, from, to));
  const phones = filtered.map((l) => l.phoneNumber);
  const orderMap = await latestOrdersByPhone(clientId, phones);

  const rows = [];
  let metrics = {
    totalAbandoned: 0,
    activeAbandoned: 0,
    recoverableRevenue: 0,
    recoveredCarts: 0,
    revenueRecovered: 0,
    recoveredFromWhatsapp: 0,
    revenueRecoveredFromWhatsapp: 0,
    averageAbandonedCartValue: 0,
  };

  let valueSum = 0;

  for (const lead of filtered) {
    const items = normalizeItems(lead);
    const totals = cartTotals(items, lead.cartSnapshot || {});
    const recovered = isRecoveredLead(lead);
    const waRecovered = isWaRecoveredLead(lead);
    const active = !recovered;

    metrics.totalAbandoned += 1;
    valueSum += totals.cartValue;

    if (active) {
      metrics.activeAbandoned += 1;
      metrics.recoverableRevenue += totals.cartValue;
    }
    if (recovered) {
      metrics.recoveredCarts += 1;
      metrics.revenueRecovered += totals.cartValue;
    }
    if (waRecovered) {
      metrics.recoveredFromWhatsapp += 1;
      metrics.revenueRecoveredFromWhatsapp += totals.cartValue;
    }

    const phoneKey = normalizePhoneKey(lead.phoneNumber);
    const latestOrder = orderMap.get(phoneKey) || null;
    const followup = buildFollowupStatus(lead, schedule);
    const recovery = recoveryStatusLabel(lead);

    rows.push({
      id: String(lead._id),
      customer: {
        name: lead.name || 'Guest',
        phone: lead.phoneNumber,
        phoneDisplay: lead.phoneNumber,
      },
      cart: {
        items,
        ...totals,
        itemCount: items.reduce((s, i) => s + i.quantity, 0),
      },
      cartValue: totals.cartValue,
      compareAtValue: totals.compareAtValue,
      currentStatus: orderStatusLabel(latestOrder, lead),
      abandonedAt: abandonDate(lead),
      recoveryStatus: recovery,
      whatsappFollowup: followup,
      recoveryStep: lead.recoveryStep || 0,
      inboxPath: `/conversations?phone=${encodeURIComponent(lead.phoneNumber || '')}`,
    });
  }

  metrics.averageAbandonedCartValue =
    metrics.totalAbandoned > 0
      ? Math.round((valueSum / metrics.totalAbandoned) * 100) / 100
      : 0;

  rows.sort((a, b) => new Date(b.abandonedAt) - new Date(a.abandonedAt));

  return {
    success: true,
    range: { from, to, preset },
    schedule,
    metrics,
    rows,
    total: rows.length,
  };
}

module.exports = {
  parseDateRange,
  getRecoverySchedule,
  buildAbandonedCartWorkspace,
};
