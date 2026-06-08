'use strict';

const moment = require('moment');
const AdLead = require('../../models/AdLead');
const Order = require('../../models/Order');
const Client = require('../../models/Client');
const log = require('../core/logger')('AbandonedCartWorkspace');
const {
  contactPhoneKey,
  getCartFollowupConfig,
  getWhatsappRecoveryMetrics,
  getRecoveryTotalsFromAttempts,
  loadLatestAttemptsByPhone,
  buildWhatsappFollowupDisplay,
  recoveryStatusFromAttempt,
} = require('./cartRecoveryAttemptService');

/** WS-3 defaults — keep aligned with
 *  `cron/abandonedCartScheduler.CART_NUDGE_DEFAULTS` so the merchant-facing
 *  cart workspace shows the same cadence the scheduler actually uses. */
const CART_NUDGE_DEFAULTS = {
  minutes1: 25,
  hours2: 4,
  hours3: 36,
};

function resolveCartNudgeDelay(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn(`[AbandonedCartWorkspace] Invalid cart nudge delay "${value}" — using default ${fallback}`);
    return fallback;
  }
  return n;
}

function getCartRecoveryDelays(client = {}) {
  const wf = client.wizardFeatures || {};
  return {
    delay1Min: resolveCartNudgeDelay(wf.cartNudgeMinutes1, CART_NUDGE_DEFAULTS.minutes1),
    delay2Hr: resolveCartNudgeDelay(wf.cartNudgeHours2, CART_NUDGE_DEFAULTS.hours2),
    delay3Hr: resolveCartNudgeDelay(wf.cartNudgeHours3, CART_NUDGE_DEFAULTS.hours3),
  };
}

const PRESETS = {
  today: () => ({ from: moment().startOf('day').toDate(), to: new Date() }),
  '7d': () => ({ from: moment().subtract(7, 'days').startOf('day').toDate(), to: new Date() }),
  '30d': () => ({ from: moment().subtract(30, 'days').startOf('day').toDate(), to: new Date() }),
  '60d': () => ({ from: moment().subtract(60, 'days').startOf('day').toDate(), to: new Date() }),
  '90d': () => ({ from: moment().subtract(90, 'days').startOf('day').toDate(), to: new Date() }),
  all: () => ({ from: new Date(0), to: new Date() }),
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

function getRecoverySchedule(client = {}) {
  const { delay1Min, delay2Hr, delay3Hr } = getCartRecoveryDelays(client);
  return [
    { step: 1, delayMinutes: delay1Min, label: `Followup 1` },
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

function buildCartTimeline(lead, followup) {
  const events = [];
  const abandonedAt = abandonDate(lead);
  if (abandonedAt) {
    events.push({
      at: abandonedAt,
      label: 'Cart abandoned',
      kind: 'abandon',
    });
  }
  for (const line of followup?.lines || []) {
    events.push({
      at: null,
      label: line.text,
      kind: line.tone || 'followup',
    });
  }
  for (const entry of (lead.activityLog || []).slice(-20)) {
    events.push({
      at: entry.timestamp || entry.at || entry.createdAt,
      label: entry.eventName || entry.action || entry.message || entry.type || 'Activity',
      kind: 'log',
    });
  }
  return events;
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

function orderStatusLabel(order, lead, delay1Min = 45) {
  if (!order && !lead.isOrderPlaced) {
    const abandonedAt = abandonDate(lead);
    const step = Number(lead.recoveryStep || 0);
    if (
      step === 0 &&
      abandonedAt &&
      (lead.cartStatus === 'abandoned' || lead.checkoutInitiatedCount > 0)
    ) {
      const minsAgo = (Date.now() - new Date(abandonedAt).getTime()) / 60000;
      if (minsAgo < delay1Min) {
        return { key: 'recent', label: 'Recently started' };
      }
    }
  }
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
  const client = await Client.findOne({ clientId }).select('wizardFeatures timezone').lean();
  const schedule = getRecoverySchedule(client || {});

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
      'phoneNumber name email cartStatus cartSnapshot cartValue cartAbandonedAt lastCartEventAt lastInteraction createdAt updatedAt isOrderPlaced recoveryStep recoveryStartedAt abandonedCartRecoveredAt recoveredViaWhatsApp activityLog addToCartCount checkoutInitiatedCount checkoutInitiatedAt'
    )
    .limit(8000)
    .lean();

  const filtered = leads.filter((l) => isAbandonCandidate(l) && leadInAbandonWindow(l, from, to));
  const phones = filtered.map((l) => l.phoneNumber);
  const orderMap = await latestOrdersByPhone(clientId, phones);

  const [followupConfig, whatsappMetrics, recoveryTotals, attemptByPhone] = await Promise.all([
    getCartFollowupConfig(clientId),
    getWhatsappRecoveryMetrics(clientId, from, to),
    getRecoveryTotalsFromAttempts(clientId, from, to),
    loadLatestAttemptsByPhone(clientId, phones),
  ]);

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
  let unknownPhoneCount = 0;
  const funnel = {
    msg1Sent: 0,
    msg2Sent: 0,
    msg3Sent: 0,
    recoveredAfterMsg1: 0,
    recoveredAfterMsg2: 0,
    recoveredAfterMsg3: 0,
  };
  const { delay1Min } = getCartRecoveryDelays(client || {});

  for (const lead of filtered) {
    if (String(lead.phoneNumber || '').startsWith('unknown_checkout_')) {
      unknownPhoneCount += 1;
    }

    const step = Number(lead.recoveryStep || 0);
    const logs = Array.isArray(lead.activityLog) ? lead.activityLog : [];
    const sentSteps = new Set();
    if (step >= 1) sentSteps.add(1);
    if (step >= 2) sentSteps.add(2);
    if (step >= 3) sentSteps.add(3);
    logs.forEach((l) => {
      const d = String(l?.details || '');
      if (d.includes('cart_step_1')) sentSteps.add(1);
      if (d.includes('cart_step_2')) sentSteps.add(2);
      if (d.includes('cart_step_3')) sentSteps.add(3);
    });
    if (sentSteps.has(1)) funnel.msg1Sent += 1;
    if (sentSteps.has(2)) funnel.msg2Sent += 1;
    if (sentSteps.has(3)) funnel.msg3Sent += 1;

    const phoneKey = contactPhoneKey(lead.phoneNumber) || normalizePhoneKey(lead.phoneNumber);
    const attempt = attemptByPhone.get(phoneKey) || null;

    if (attempt?.recoveredViaWhatsapp) {
      const sentNums = (attempt.whatsappTemplatesSent || []).map((t) => Number(t.followupNumber)).filter(Boolean);
      const recoverStep = sentNums.length ? Math.max(...sentNums) : Number(lead.recoveryStep || 1);
      if (recoverStep >= 3) funnel.recoveredAfterMsg3 += 1;
      else if (recoverStep >= 2) funnel.recoveredAfterMsg2 += 1;
      else funnel.recoveredAfterMsg1 += 1;
    } else if (isWaRecoveredLead(lead)) {
      const recoverStep = step || 1;
      if (recoverStep >= 3) funnel.recoveredAfterMsg3 += 1;
      else if (recoverStep >= 2) funnel.recoveredAfterMsg2 += 1;
      else funnel.recoveredAfterMsg1 += 1;
    }

    const items = normalizeItems(lead);
    const totals = cartTotals(items, lead.cartSnapshot || {});
    const recovered =
      attempt?.status === 'recovered' || isRecoveredLead(lead);
    const active = !recovered;

    metrics.totalAbandoned += 1;
    valueSum += totals.cartValue;

    if (active) {
      metrics.activeAbandoned += 1;
      metrics.recoverableRevenue += totals.cartValue;
    }

    const phoneKeyOrder = normalizePhoneKey(lead.phoneNumber);
    const latestOrder = orderMap.get(phoneKeyOrder) || null;
    const followup = buildWhatsappFollowupDisplay(attempt, followupConfig);
    const recovery = recoveryStatusFromAttempt(attempt, lead);

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
      currentStatus: orderStatusLabel(latestOrder, lead, delay1Min),
      abandonedAt: abandonDate(lead),
      recoveryStatus: recovery,
      whatsappFollowup: followup,
      cartRecoveryAttempt: attempt
        ? {
            status: attempt.status,
            recoveredViaWhatsapp: attempt.recoveredViaWhatsapp,
            organicRecovery: attempt.organicRecovery,
            whatsappMessageSentAt: attempt.whatsappMessageSentAt,
            whatsappTemplatesSent: attempt.whatsappTemplatesSent || [],
          }
        : null,
      recoveryStep: lead.recoveryStep || 0,
      timeline: buildCartTimeline(lead, followup),
      leadId: String(lead._id),
      inboxPath: `/conversations?phone=${encodeURIComponent(lead.phoneNumber || '')}`,
    });
  }

  metrics.averageAbandonedCartValue =
    metrics.totalAbandoned > 0
      ? Math.round((valueSum / metrics.totalAbandoned) * 100) / 100
      : 0;

  metrics.recoveredCarts = recoveryTotals.recoveredCarts;
  metrics.revenueRecovered = recoveryTotals.revenueRecovered;
  metrics.recoveredFromWhatsapp = whatsappMetrics.configured
    ? whatsappMetrics.recoveredViaWhatsapp
    : null;
  metrics.revenueRecoveredFromWhatsapp = whatsappMetrics.configured
    ? whatsappMetrics.waRevenueRecovered
    : null;
  metrics.whatsappRecovery = whatsappMetrics;

  metrics.unknownPhoneCount = unknownPhoneCount;
  metrics.unknownPhonePct =
    metrics.totalAbandoned > 0
      ? Math.round((unknownPhoneCount / metrics.totalAbandoned) * 10000) / 100
      : 0;

  const totalWaRecovered =
    funnel.recoveredAfterMsg1 + funnel.recoveredAfterMsg2 + funnel.recoveredAfterMsg3;
  funnel.effectiveness = {
    msg1Pct:
      totalWaRecovered > 0
        ? Math.round((funnel.recoveredAfterMsg1 / totalWaRecovered) * 100)
        : 0,
    msg2Pct:
      totalWaRecovered > 0
        ? Math.round((funnel.recoveredAfterMsg2 / totalWaRecovered) * 100)
        : 0,
    msg3Pct:
      totalWaRecovered > 0
        ? Math.round((funnel.recoveredAfterMsg3 / totalWaRecovered) * 100)
        : 0,
  };

  metrics.recoveryRate =
    metrics.totalAbandoned > 0
      ? Math.round((metrics.recoveredCarts / metrics.totalAbandoned) * 10000) / 100
      : 0;

  rows.sort((a, b) => new Date(b.abandonedAt) - new Date(a.abandonedAt));

  return {
    success: true,
    range: { from, to, preset },
    schedule,
    metrics,
    funnel,
    rows,
    total: rows.length,
  };
}

module.exports = {
  parseDateRange,
  getRecoverySchedule,
  buildAbandonedCartWorkspace,
};
