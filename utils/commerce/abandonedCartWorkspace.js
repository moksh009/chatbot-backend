'use strict';

const moment = require('moment');
const { startOfDayIST, startOfDayForDateStrIST, endOfDayForDateStrIST, formatDateStrIST } = require('../core/queryHelpers');
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
  buildRecoveryTimeline,
  summarizeMessageEngagement,
  buildAbandonHeatmap: buildAbandonHeatmapData,
} = require('./cartRecoveryAttemptService');
const { predictRecoveryValue } = require('./cartRecoveryPrediction');
const { buildConnectionStatusPayload } = require('../core/connectionStatus');
const { ABANDONED_CART_TAG } = require('../../constants/cartRecoveryTags');
const {
  getCartRecoveryDelays,
  getCartRecoveryConfig,
  computeNextPromotionAt,
  buildConfigPayload,
} = require('./cartRecoveryConfigService');

const PRESETS = {
  today: () => ({ from: startOfDayIST(), to: new Date(), timezone: 'Asia/Kolkata' }),
  '7d': () => {
    const endStr = formatDateStrIST(new Date());
    const startStr = formatDateStrIST(new Date(Date.now() - 6 * 86400000));
    return { from: startOfDayForDateStrIST(startStr), to: new Date(), timezone: 'Asia/Kolkata' };
  },
  '30d': () => {
    const endStr = formatDateStrIST(new Date());
    const startStr = formatDateStrIST(new Date(Date.now() - 29 * 86400000));
    return { from: startOfDayForDateStrIST(startStr), to: new Date(), timezone: 'Asia/Kolkata' };
  },
  '60d': () => {
    const startStr = formatDateStrIST(new Date(Date.now() - 59 * 86400000));
    return { from: startOfDayForDateStrIST(startStr), to: new Date(), timezone: 'Asia/Kolkata' };
  },
  '90d': () => {
    const startStr = formatDateStrIST(new Date(Date.now() - 89 * 86400000));
    return { from: startOfDayForDateStrIST(startStr), to: new Date(), timezone: 'Asia/Kolkata' };
  },
  all: () => ({ from: new Date(0), to: new Date(), timezone: 'Asia/Kolkata' }),
};

function parseDateRange(query = {}) {
  const preset = String(query.preset || '').toLowerCase();
  if (preset && PRESETS[preset]) return { ...PRESETS[preset](), preset };

  const fromRaw = query.from || query.startDate;
  const toRaw = query.to || query.endDate;
  if (fromRaw && toRaw) {
    const fromStr = formatDateStrIST(new Date(fromRaw));
    const toStr = formatDateStrIST(new Date(toRaw));
    const from = startOfDayForDateStrIST(fromStr);
    const to = endOfDayForDateStrIST(toStr);
    if (from <= to) return { from, to, preset: 'custom', timezone: 'Asia/Kolkata' };
  }

  return { ...PRESETS['30d'](), preset: '30d' };
}

function getRecoverySchedule(client = {}) {
  const { promotionDelayMin, delay1Min, delay2Min, delay3Min } = getCartRecoveryDelays(client);
  const fmtDelay = (mins) => {
    if (mins < 60) return `${mins} min`;
    if (mins < 1440) return `${Math.round(mins / 60)}h`;
    return `${Math.round(mins / 1440)}d`;
  };
  return {
    promotionDelayMinutes: promotionDelayMin,
    promotionLabel: `${fmtDelay(promotionDelayMin)} after last checkout activity`,
    steps: [
    {
      step: 1,
      delayMinutes: delay1Min,
      label: 'Followup 1',
      timingLabel: `${fmtDelay(delay1Min)} after cart abandoned`,
      fromAbandonTime: true,
    },
    {
      step: 2,
      delayMinutes: delay2Min,
      label: 'Followup 2',
      timingLabel: `${fmtDelay(delay2Min)} after cart abandoned (requires message 1 sent)`,
      fromAbandonTime: true,
    },
    {
      step: 3,
      delayMinutes: delay3Min,
      label: 'Followup 3',
      timingLabel: `${fmtDelay(delay3Min)} after cart abandoned (requires message 2 sent)`,
      fromAbandonTime: true,
    },
    ],
  };
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

function cartTotals(items, snap = {}, lead = {}) {
  const lineSum = items.reduce((s, i) => s + (i.lineTotal || 0), 0);
  const total =
    lineSum ||
    Number(snap.total_price ?? snap.totalPrice ?? lead.cartValue ?? 0) ||
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

    const dueAt = moment(abandonedAt).add(s.delayMinutes, 'minutes');

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

function buildCartTimeline(lead, followup, attempt = null) {
  const fromAttempt = buildRecoveryTimeline(lead, attempt || followup?.attempt);
  if (fromAttempt.length) return fromAttempt;

  const events = [];
  const abandonedAt = abandonDate(lead);
  if (abandonedAt) {
    events.push({ at: abandonedAt, label: 'Cart abandoned', kind: 'abandon' });
  }
  for (const line of followup?.lines || []) {
    events.push({ at: null, label: line.text, kind: line.tone || 'followup' });
  }
  return events;
}

function isNonRecoverableLead(lead) {
  const phone = String(lead?.phoneNumber || '');
  return !phone || phone.startsWith('unknown_checkout_') || phone.startsWith('unknown_email_');
}

function recoveryStatusLabel(lead) {
  if (lead.cartStatus === 'active' && lead.contactCapturedAt) {
    return { key: 'in_checkout', label: 'In checkout' };
  }
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
    if (lead.cartStatus === 'active' && lead.contactCapturedAt) {
      return { key: 'in_checkout', label: 'In checkout' };
    }
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

function buildSetupStatus(client, flags = {}) {
  const shopifyConnected = Boolean(flags.shopify_connected);
  const whatsappConnected = Boolean(flags.whatsapp_connected);
  const wf = client?.wizardFeatures || {};
  const cartRules = (client?.commerceAutomations || []).filter(
    (a) => a.meta?.category === 'abandoned_cart' && a.isActive === true
  );
  return {
    shopifyConnected,
    whatsappConnected,
    canView: shopifyConnected,
    canSend: whatsappConnected,
    canEnable: shopifyConnected && whatsappConnected,
    recoveryActive: wf.enableAbandonedCart !== false && cartRules.length > 0,
    viewBlockedReason: shopifyConnected ? null : 'Connect Shopify to see real cart leads.',
    sendBlockedReason: whatsappConnected ? null : 'Connect WhatsApp to send recovery messages.',
  };
}

async function buildAbandonedCartWorkspace(clientId, query = {}) {
  const { from, to, preset } = parseDateRange(query);
  const client = await Client.findOne({ clientId })
    .select('wizardFeatures cartRecoveryConfig timezone commerceAutomations shopifyConnected shopifyAccessToken whatsappToken phoneNumberId wabaId')
    .lean();
  const connectionFlags = buildConnectionStatusPayload(client || {});
  const setupStatus = buildSetupStatus(client, connectionFlags);
  const schedule = getRecoverySchedule(client || {});
  const cartRecoveryConfig = buildConfigPayload(client || {});

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
      'phoneNumber name email cartStatus cartSnapshot cartValue cartAbandonedAt contactCapturedAt lastCartEventAt lastInteraction createdAt updatedAt isOrderPlaced recoveryStep recoveryStartedAt abandonedCartRecoveredAt recoveredViaWhatsApp activityLog addToCartCount checkoutInitiatedCount checkoutInitiatedAt tags nextPromotionAt nextAllowedSendAt cartValueTier recoveryUrl exitIntentAt visitorFirstVisitAt visitorVisitCount'
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
    nonRecoverableCount: 0,
    recoveredCarts: 0,
    revenueRecovered: 0,
    recoveredFromWhatsapp: 0,
    revenueRecoveredFromWhatsapp: 0,
    organicRecovered: 0,
    organicRevenue: 0,
    linkClicks: 0,
    buttonClicks: 0,
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
  const { delay1Min, promotionDelayMin } = getCartRecoveryDelays(client || {});

  for (const lead of filtered) {
    const nonRecoverable = isNonRecoverableLead(lead);
    if (nonRecoverable) {
      unknownPhoneCount += 1;
      metrics.nonRecoverableCount += 1;
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
    const totals = cartTotals(items, lead.cartSnapshot || {}, lead);
    const recovered =
      attempt?.status === 'recovered' || isRecoveredLead(lead);
    const active = !recovered;

    metrics.totalAbandoned += 1;
    valueSum += totals.cartValue;

    if (active) {
      if (!nonRecoverable) {
        metrics.activeAbandoned += 1;
        metrics.recoverableRevenue += totals.cartValue;
      }
    } else {
      metrics.recoveredCarts += 1;
      const recoveredValue =
        Number(attempt?.recoveredOrderValue || attempt?.recoveredOrderAmount || 0) ||
        totals.cartValue;
      metrics.revenueRecovered += recoveredValue;
      if (attempt?.recoveredViaWhatsapp || isWaRecoveredLead(lead)) {
        metrics.recoveredFromWhatsapp += 1;
        metrics.revenueRecoveredFromWhatsapp += recoveredValue;
      } else {
        metrics.organicRecovered += 1;
        metrics.organicRevenue += recoveredValue;
      }
    }

    const phoneKeyOrder = normalizePhoneKey(lead.phoneNumber);
    const latestOrder = orderMap.get(phoneKeyOrder) || null;
    const followup = buildWhatsappFollowupDisplay(
      attempt,
      followupConfig,
      Number(lead.recoveryStep || 0)
    );
    const recovery = recoveryStatusFromAttempt(attempt, lead);

    const engagement = summarizeMessageEngagement(attempt);
    metrics.linkClicks += engagement.linkClicks;
    metrics.buttonClicks += engagement.buttonClicks;
    const leadTags = Array.isArray(lead.tags) ? lead.tags : [];

    rows.push({
      id: String(lead._id),
      customer: {
        name: lead.name || 'Guest',
        phone: lead.phoneNumber,
        phoneDisplay: lead.phoneNumber,
        tags: leadTags.includes(ABANDONED_CART_TAG)
          ? leadTags
          : !recovered && !nonRecoverable
            ? [...leadTags, ABANDONED_CART_TAG]
            : leadTags,
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
      engagement,
      cartRecoveryAttempt: attempt
        ? {
            status: attempt.status,
            recoveredViaWhatsapp: attempt.recoveredViaWhatsapp,
            organicRecovery: attempt.organicRecovery,
            whatsappMessageSentAt: attempt.whatsappMessageSentAt,
            whatsappTemplatesSent: attempt.whatsappTemplatesSent || [],
            lastSendFailure: attempt.lastSendFailure || null,
          }
        : null,
      nonRecoverable,
      sendFailure: attempt?.lastSendFailure?.reason
        ? {
            step: attempt.lastSendFailure.step,
            reason: attempt.lastSendFailure.reason,
            detail: attempt.lastSendFailure.detail,
            at: attempt.lastSendFailure.at,
          }
        : null,
      recoveryStep: lead.recoveryStep || 0,
      predictedRecoveryValue: active && !nonRecoverable
        ? predictRecoveryValue(totals.cartValue, lead.recoveryStep || 0)
        : 0,
      cartValueTier: lead.cartValueTier || '',
      exitIntentAt: lead.exitIntentAt || null,
      hasExitIntent: !!lead.exitIntentAt,
      visitorFirstVisitAt: lead.visitorFirstVisitAt || null,
      visitorVisitCount: lead.visitorVisitCount ?? null,
      nextPromotionAt:
        lead.nextPromotionAt ||
        (lead.cartStatus === 'active'
          ? computeNextPromotionAt(lead, promotionDelayMin)
          : null),
      nextAllowedSendAt: lead.nextAllowedSendAt || null,
      recoveryUrl: lead.recoveryUrl || '',
      timeline: buildCartTimeline(lead, followup, attempt),
      leadId: String(lead._id),
      inboxPath: `/conversations?phone=${encodeURIComponent(lead.phoneNumber || '')}`,
    });
  }

  metrics.averageAbandonedCartValue =
    metrics.totalAbandoned > 0
      ? Math.round((valueSum / metrics.totalAbandoned) * 100) / 100
      : 0;

  if (recoveryTotals.recoveredCarts > metrics.recoveredCarts) {
    metrics.recoveredCarts = recoveryTotals.recoveredCarts;
    metrics.revenueRecovered = recoveryTotals.revenueRecovered;
    metrics.organicRecovered = recoveryTotals.organicRecovered || 0;
    metrics.organicRevenue = recoveryTotals.organicRevenue || 0;
  }
  if (whatsappMetrics.configured) {
    if (whatsappMetrics.recoveredViaWhatsapp > metrics.recoveredFromWhatsapp) {
      metrics.recoveredFromWhatsapp = whatsappMetrics.recoveredViaWhatsapp;
    }
    if (whatsappMetrics.waRevenueRecovered > metrics.revenueRecoveredFromWhatsapp) {
      metrics.revenueRecoveredFromWhatsapp = whatsappMetrics.waRevenueRecovered;
    }
  } else {
    metrics.recoveredFromWhatsapp = metrics.recoveredFromWhatsapp || 0;
    metrics.revenueRecoveredFromWhatsapp = metrics.revenueRecoveredFromWhatsapp || 0;
  }
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

  metrics.messagesSent = (funnel.msg1Sent || 0) + (funnel.msg2Sent || 0) + (funnel.msg3Sent || 0);
  metrics.hero = {
    recoverableRevenue: metrics.recoverableRevenue,
    recoveredCarts: metrics.recoveredCarts,
    revenueRecovered: metrics.revenueRecovered,
    messagesSent: metrics.messagesSent,
    predictedRecoveryValue: rows.reduce(
      (sum, row) => sum + (Number(row.predictedRecoveryValue) || 0),
      0
    ),
  };

  rows.sort((a, b) => new Date(b.abandonedAt) - new Date(a.abandonedAt));

  return {
    success: true,
    range: { from, to, preset },
    schedule,
    cartRecoveryConfig,
    setupStatus,
    metrics,
    funnel,
    rows,
    total: rows.length,
  };
}

async function buildAbandonHeatmap(clientId, query = {}) {
  const { from, to, preset } = parseDateRange(query);
  const heatmap = await buildAbandonHeatmapData(clientId, from, to);
  return {
    success: true,
    range: { from, to, preset },
    ...heatmap,
  };
}

module.exports = {
  parseDateRange,
  getRecoverySchedule,
  buildAbandonedCartWorkspace,
  buildAbandonHeatmap,
};
