'use strict';

const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const Client = require('../models/Client');
const log = require('../utils/core/logger')('CartRecoveryMetrics');
const {
  startOfDayForDateStrIST,
  endOfDayForDateStrIST,
  formatDateStrIST,
} = require('../utils/core/queryHelpers');
const {
  contactPhoneKey,
  loadLatestAttemptsByPhone,
  getWhatsappRecoveryMetrics,
} = require('../utils/commerce/cartRecoveryAttemptService');
const {
  reconcileOpenCartLeadsForClient,
  orderRecoversAbandonedLead,
  reconcileCartRecoveryFromShopifyOrder,
  shopifyPayloadFromOrder,
} = require('../utils/commerce/cartRecoveryOrderReconcile');
const { normalizeEmail } = require('../utils/commerce/marketingConsent');

// ─── Date helpers ───────────────────────────────────────────────────────────

function defaultDateRange() {
  const endStr = formatDateStrIST(new Date());
  const startStr = formatDateStrIST(new Date(Date.now() - 29 * 86400000));
  return {
    from: startOfDayForDateStrIST(startStr),
    to: new Date(),
    timezone: 'Asia/Kolkata',
  };
}

function resolveDateRange(options = {}) {
  const timezone = options.timezone || 'Asia/Kolkata';
  if (options.from instanceof Date && options.to instanceof Date && options.from <= options.to) {
    return { from: options.from, to: options.to, timezone };
  }
  return defaultDateRange();
}

// ─── Lead / cart helpers (mirrors abandonedCartWorkspace.js) ────────────────

function normalizePhoneKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function isPlaceholderPhone(phone) {
  const p = String(phone || '');
  return !p || p.startsWith('unknown_checkout_') || p.startsWith('unknown_email_');
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

function isRecoveredLead(lead) {
  return (
    lead.cartStatus === 'recovered' ||
    lead.cartStatus === 'purchased' ||
    lead.isOrderPlaced === true
  );
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

function isWaRecoveredLead(lead) {
  if (!isRecoveredLead(lead)) return false;
  return waMessagesSent(lead);
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

function leadPriorityScore(lead) {
  let score = 0;
  if (!isPlaceholderPhone(lead.phoneNumber)) score += 40;
  if (lead.cartStatus === 'abandoned') score += 30;
  else if (lead.cartStatus === 'active') score += 20;
  else if (isRecoveredLead(lead)) score += 10;
  if (lead.contactCapturedAt) score += 5;
  if (lead.checkoutToken || lead.cartSnapshot?.checkoutToken) score += 3;
  return score;
}

function sessionDedupeKey(lead) {
  const token = String(lead.checkoutToken || lead.cartSnapshot?.checkoutToken || '').trim();
  if (token) return `token:${token}`;

  const phoneKey = normalizePhoneKey(lead.phoneNumber);
  if (phoneKey && phoneKey.length >= 8 && !isPlaceholderPhone(lead.phoneNumber)) {
    return `phone:${phoneKey}`;
  }

  if (lead.email) {
    return `email:${String(lead.email).trim().toLowerCase()}`;
  }

  const val = Math.round(Number(lead.cartValue || lead.cartSnapshot?.total_price || 0));
  const t = abandonDate(lead);
  if (t && val > 0) {
    const bucket = Math.floor(new Date(t).getTime() / (5 * 60 * 1000));
    return `session:${val}:${bucket}`;
  }

  return `id:${lead._id}`;
}

function pickCanonicalLead(a, b) {
  const aPlaceholder = isPlaceholderPhone(a.phoneNumber);
  const bPlaceholder = isPlaceholderPhone(b.phoneNumber);
  if (aPlaceholder !== bPlaceholder) return aPlaceholder ? b : a;

  const scoreA = leadPriorityScore(a);
  const scoreB = leadPriorityScore(b);
  if (scoreA !== scoreB) return scoreB > scoreA ? b : a;

  const timeA = new Date(a.lastCartEventAt || a.updatedAt || 0).getTime();
  const timeB = new Date(b.lastCartEventAt || b.updatedAt || 0).getTime();
  return timeB >= timeA ? b : a;
}

function dedupeLeadsForWorkspace(leads = []) {
  const byKey = new Map();
  for (const lead of leads) {
    const key = sessionDedupeKey(lead);
    const existing = byKey.get(key);
    byKey.set(key, existing ? pickCanonicalLead(existing, lead) : lead);
  }
  let result = [...byKey.values()];

  const byPhone = new Map();
  for (const lead of result) {
    const phoneKey = normalizePhoneKey(lead.phoneNumber);
    if (phoneKey.length < 8 || isPlaceholderPhone(lead.phoneNumber)) continue;
    const existing = byPhone.get(phoneKey);
    byPhone.set(phoneKey, existing ? pickCanonicalLead(existing, lead) : lead);
  }

  const byToken = new Map();
  for (const lead of result) {
    const token = String(lead.checkoutToken || lead.cartSnapshot?.checkoutToken || '').trim();
    if (!token) continue;
    const existing = byToken.get(token);
    byToken.set(token, existing ? pickCanonicalLead(existing, lead) : lead);
  }

  const seen = new Set();
  const merged = [];
  for (const lead of result) {
    const phoneKey = normalizePhoneKey(lead.phoneNumber);
    const token = String(lead.checkoutToken || lead.cartSnapshot?.checkoutToken || '').trim();
    const canonical =
      (phoneKey.length >= 8 && !isPlaceholderPhone(lead.phoneNumber) && byPhone.get(phoneKey)) ||
      (token && byToken.get(token)) ||
      lead;
    const id = String(canonical._id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(canonical);
  }
  return merged;
}

function normalizeItems(lead) {
  const snap = lead.cartSnapshot || {};
  const raw = Array.isArray(snap.items) ? snap.items : [];
  if (raw.length) {
    return raw.map((item, idx) => {
      const qty = Number(item.quantity || item.qty || 1) || 1;
      const price = Number(item.price ?? item.line_price ?? item.presentment_price ?? 0) || 0;
      return {
        id: String(item.variant_id || item.id || idx),
        title: item.title || item.name || item.product_title || `Item ${idx + 1}`,
        quantity: qty,
        price,
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
    lineTotal: each,
  }));
}

function cartTotals(items, snap = {}, lead = {}) {
  const lineSum = items.reduce((s, i) => s + (i.lineTotal || 0), 0);
  const total =
    lineSum ||
    Number(snap.total_price ?? snap.totalPrice ?? lead.cartValue ?? 0) ||
    0;
  return { cartValue: total, currency: snap.currency || 'INR' };
}

// ─── Recovery resolution ─────────────────────────────────────────────────────

function isRecovered(lead, matchedOrder, attempt = null) {
  return (
    attempt?.status === 'recovered' ||
    isRecoveredLead(lead) ||
    orderRecoversAbandonedLead(matchedOrder, lead)
  );
}

function sumRecoveredRevenue(lead, matchedOrder, attempt = null, totals = {}) {
  const attemptValue =
    Number(attempt?.recoveredOrderValue || attempt?.recoveredOrderAmount || 0) || 0;
  if (attemptValue > 0) return attemptValue;
  if (matchedOrder) {
    const orderPrice = Number(matchedOrder.totalPrice || matchedOrder.amount || 0) || 0;
    if (orderPrice > 0) return orderPrice;
  }
  return Number(totals.cartValue || lead.cartValue || 0) || 0;
}

function pickOrderForLead(lead, orderMaps) {
  const phoneKey = normalizePhoneKey(lead.phoneNumber);
  const emailKey = normalizeEmail(lead.email);
  const abandonAt = abandonDate(lead);
  const recoveredId = String(lead?.recoveredOrderId || lead?.lastOrderId || '').trim();

  const phoneCandidates = phoneKey.length >= 8 ? orderMaps.byPhone.get(phoneKey) || [] : [];
  const emailCandidates = emailKey ? orderMaps.byEmail.get(emailKey) || [] : [];

  const candidates = [...phoneCandidates];
  for (const o of emailCandidates) {
    const key = o.shopifyOrderId || o.orderId || String(o._id);
    if (!candidates.some((c) => (c.shopifyOrderId || c.orderId || String(c._id)) === key)) {
      candidates.push(o);
    }
  }

  if (!candidates.length) return null;

  let pick = null;
  if (recoveredId) {
    pick = candidates.find((o) => {
      const ids = [o.orderId, o.orderNumber, o.shopifyOrderId].map((v) =>
        String(v || '').replace(/^#/, '').trim()
      );
      const rid = recoveredId.replace(/^#/, '').trim();
      return ids.some((id) => id && (id === rid || id.endsWith(rid) || rid.endsWith(id)));
    });
  }
  if (!pick && abandonAt) {
    const abandonMs = new Date(abandonAt).getTime() - 2 * 60 * 1000;
    pick = candidates.find((o) => o.createdAt && new Date(o.createdAt).getTime() >= abandonMs);
  }
  return pick || candidates[0] || null;
}

// ─── Order contact map (phone + email) ─────────────────────────────────────

async function buildOrderContactMap(clientId, leads = [], options = {}) {
  const phoneSuffixes = new Set();
  const emailKeys = new Set();

  for (const lead of leads) {
    const phoneKey = normalizePhoneKey(lead.phoneNumber);
    if (phoneKey.length >= 8 && !isPlaceholderPhone(lead.phoneNumber)) {
      phoneSuffixes.add(phoneKey);
    }
    const emailKey = normalizeEmail(lead.email);
    if (emailKey) emailKeys.add(emailKey);
  }

  if (!phoneSuffixes.size && !emailKeys.size) {
    return { byPhone: new Map(), byEmail: new Map() };
  }

  const cohortFrom =
    options.from instanceof Date
      ? options.from
      : leads.reduce((min, lead) => {
          const d = abandonDate(lead);
          if (!d) return min;
          const t = new Date(d).getTime();
          return min == null || t < min ? t : min;
        }, null);
  const orderSince = new Date(
    (cohortFrom instanceof Date ? cohortFrom.getTime() : cohortFrom || Date.now()) - 7 * 86400000
  );

  const orders = await Order.find({
    clientId,
    createdAt: { $gte: orderSince },
  })
    .sort({ createdAt: -1 })
    .select(
      'phone customerPhone orderId orderNumber shopifyOrderId financialStatus fulfillmentStatus status totalPrice amount createdAt customerEmail email'
    )
    .limit(3000)
    .lean();

  const byPhone = new Map();
  const byEmail = new Map();

  for (const o of orders) {
    const phoneKey = normalizePhoneKey(o.customerPhone || o.phone);
    if (phoneKey.length >= 8 && phoneSuffixes.has(phoneKey)) {
      if (!byPhone.has(phoneKey)) byPhone.set(phoneKey, []);
      byPhone.get(phoneKey).push(o);
    }

    const emailKey = normalizeEmail(o.customerEmail || o.email);
    if (emailKey && emailKeys.has(emailKey)) {
      if (!byEmail.has(emailKey)) byEmail.set(emailKey, []);
      byEmail.get(emailKey).push(o);
    }
  }

  return { byPhone, byEmail };
}

// ─── Cohort builder ──────────────────────────────────────────────────────────

const LEAD_SELECT =
  'phoneNumber name email cartStatus cartSnapshot cartValue cartAbandonedAt contactCapturedAt lastCartEventAt lastInteraction createdAt updatedAt isOrderPlaced recoveryStep recoveryStartedAt abandonedCartRecoveredAt recoveredViaWhatsApp activityLog addToCartCount checkoutInitiatedCount checkoutInitiatedAt checkoutToken tags recoveredAt recoveredOrderId lastOrderId lastPurchaseDate';

async function fetchAbandonLeads(clientId, from, to) {
  return AdLead.find({
    clientId,
    $or: [
      { cartAbandonedAt: { $gte: from, $lte: to } },
      {
        cartStatus: { $in: ['abandoned', 'recovered', 'active', 'purchased'] },
        updatedAt: { $gte: from, $lte: to },
        addToCartCount: { $gt: 0 },
      },
      {
        addToCartCount: { $gt: 0 },
        lastInteraction: { $gte: from, $lte: to },
      },
    ],
  })
    .select(LEAD_SELECT)
    .limit(8000)
    .lean();
}

function buildAbandonCohort(leads, from, to) {
  return dedupeLeadsForWorkspace(
    leads.filter((l) => isAbandonCandidate(l) && leadInAbandonWindow(l, from, to))
  );
}

function leadInActivityWindow(lead, from, to, matchedOrder) {
  const dates = [
    lead.recoveredAt,
    lead.abandonedCartRecoveredAt,
    lead.lastPurchaseDate,
    matchedOrder?.createdAt,
  ].filter(Boolean);
  if (!dates.length) return false;
  return dates.some((d) => {
    const t = new Date(d).getTime();
    return t >= from.getTime() && t <= to.getTime();
  });
}

async function persistRecoveriesFromOrderMap(client, leads, orderMaps) {
  if (!client?.clientId || !leads?.length) return 0;
  let persisted = 0;
  for (const lead of leads) {
    if (isRecoveredLead(lead)) continue;
    const order = pickOrderForLead(lead, orderMaps);
    if (!order || !orderRecoversAbandonedLead(order, lead)) continue;
    const out = await reconcileCartRecoveryFromShopifyOrder(
      client,
      shopifyPayloadFromOrder(order, lead),
      { source: 'metrics_order_map' }
    );
    if (out.matched && !out.duplicate && !out.error) persisted += 1;
  }
  return persisted;
}

// ─── Funnel helpers ──────────────────────────────────────────────────────────

function collectSentSteps(lead) {
  const step = Number(lead.recoveryStep || 0);
  const sentSteps = new Set();
  if (step >= 1) sentSteps.add(1);
  if (step >= 2) sentSteps.add(2);
  if (step >= 3) sentSteps.add(3);
  const logs = Array.isArray(lead.activityLog) ? lead.activityLog : [];
  logs.forEach((l) => {
    const d = String(l?.details || '');
    if (d.includes('cart_step_1')) sentSteps.add(1);
    if (d.includes('cart_step_2')) sentSteps.add(2);
    if (d.includes('cart_step_3')) sentSteps.add(3);
  });
  return sentSteps;
}

function trackFunnelRecovery(funnel, attempt, lead) {
  const step = Number(lead.recoveryStep || 0);
  if (attempt?.recoveredViaWhatsapp) {
    const sentNums = (attempt.whatsappTemplatesSent || [])
      .map((t) => Number(t.followupNumber))
      .filter(Boolean);
    const recoverStep = sentNums.length ? Math.max(...sentNums) : step || 1;
    if (recoverStep >= 3) funnel.recoveredAfterMsg3 += 1;
    else if (recoverStep >= 2) funnel.recoveredAfterMsg2 += 1;
    else funnel.recoveredAfterMsg1 += 1;
  } else if (isWaRecoveredLead(lead)) {
    const recoverStep = step || 1;
    if (recoverStep >= 3) funnel.recoveredAfterMsg3 += 1;
    else if (recoverStep >= 2) funnel.recoveredAfterMsg2 += 1;
    else funnel.recoveredAfterMsg1 += 1;
  }
}

function chartBucketKey(date, unit = 'day') {
  if (!date) return null;
  if (unit === 'day') return formatDateStrIST(date);
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return formatDateStrIST(d);
}

function bumpChartBucket(chartBuckets, key, { recovered, messaged }) {
  if (!key || !chartBuckets) return;
  if (!chartBuckets.has(key)) {
    chartBuckets.set(key, { date: key, abandoned: 0, recovered: 0, stillAbandoned: 0, messaged: 0 });
  }
  const pt = chartBuckets.get(key);
  pt.abandoned += 1;
  if (recovered) pt.recovered += 1;
  else pt.stillAbandoned += 1;
  if (messaged) pt.messaged += 1;
}

// ─── Main calculation ────────────────────────────────────────────────────────

async function calculateRecoveryMetrics(clientId, options = {}) {
  const mode = options.mode === 'activity' ? 'activity' : 'cohort';
  const { from, to, timezone } = resolveDateRange(options);
  const includeFunnel = options.includeFunnel !== false;
  const includeRows = options.includeRows === true;
  const includeChartBuckets = options.includeChartBuckets === true;
  const chartBucketUnit = options.chartBucketUnit || 'day';
  const reconcileFirst = options.reconcileFirst === true;
  const persistOrderMap = options.persistOrderMap === true;

  const {
    buildRecoveryMetricsCacheKey,
    readRecoveryMetricsCache,
    writeRecoveryMetricsCache,
    shouldBypassRecoveryMetricsCache,
    dedupeRecoveryMetricsCompute,
  } = require('../utils/commerce/cartRecoveryMetricsCache');

  const cacheKey = buildRecoveryMetricsCacheKey(clientId, options, { from, to, timezone });
  const bypassCache = shouldBypassRecoveryMetricsCache(options);

  if (!bypassCache) {
    const cached = readRecoveryMetricsCache(cacheKey);
    if (cached) {
      return JSON.parse(JSON.stringify(cached));
    }
  }

  return dedupeRecoveryMetricsCompute(cacheKey, async () => {
    if (!bypassCache) {
      const cachedAgain = readRecoveryMetricsCache(cacheKey);
      if (cachedAgain) {
        return JSON.parse(JSON.stringify(cachedAgain));
      }
    }

    return computeRecoveryMetricsBody(clientId, {
      mode,
      from,
      to,
      timezone,
      includeFunnel,
      includeRows,
      includeChartBuckets,
      chartBucketUnit,
      reconcileFirst,
      persistOrderMap,
      prefetchedCohort: options.prefetchedCohort,
      prefetchedOrderMaps: options.prefetchedOrderMaps,
      cacheKey,
      bypassCache,
    });
  });
}

async function computeRecoveryMetricsBody(clientId, options) {
  const {
    mode,
    from,
    to,
    timezone,
    includeFunnel,
    includeRows,
    includeChartBuckets,
    chartBucketUnit,
    reconcileFirst,
    persistOrderMap,
    cacheKey,
    bypassCache,
  } = options;

  const { writeRecoveryMetricsCache } = require('../utils/commerce/cartRecoveryMetricsCache');

  if (reconcileFirst) {
    const reconcileSince = new Date(Math.min(from.getTime(), Date.now() - 90 * 86400000));
    await reconcileOpenCartLeadsForClient(clientId, {
      since: reconcileSince,
      maxLeads: 400,
    }).catch((err) => {
      log.warn(`[CartRecoveryMetrics] recovery reconcile skipped: ${err.message}`);
    });
  }

  const client = await Client.findOne({ clientId })
    .select('wizardFeatures cartRecoveryConfig commerceAutomations')
    .lean();

  let cohort;
  if (Array.isArray(options.prefetchedCohort)) {
    cohort = options.prefetchedCohort;
  } else {
    const rawLeads = await fetchAbandonLeads(clientId, from, to);
    cohort = buildAbandonCohort(rawLeads, from, to);
  }

  const orderMaps =
    options.prefetchedOrderMaps && options.prefetchedOrderMaps.byPhone
      ? options.prefetchedOrderMaps
      : await buildOrderContactMap(clientId, cohort, { from });
  const phones = cohort.map((l) => l.phoneNumber);

  let persisted = 0;
  if (persistOrderMap) {
    persisted = await persistRecoveriesFromOrderMap(client, cohort, orderMaps).catch((err) => {
      log.warn(`[CartRecoveryMetrics] order-map reconcile skipped: ${err.message}`);
      return 0;
    });
  }

  if (persisted > 0) {
    const refreshed = await AdLead.find({
      clientId,
      _id: { $in: cohort.map((l) => l._id) },
    })
      .select(LEAD_SELECT)
      .lean();
    const byId = new Map(refreshed.map((l) => [String(l._id), l]));
    cohort = cohort.map((l) => byId.get(String(l._id)) || l);
  }

  const JourneyRevenueAttribution = require('../models/JourneyRevenueAttribution');

  const [whatsappMetrics, attemptByPhone, journeyCartRevenueResult] = await Promise.all([
    getWhatsappRecoveryMetrics(clientId, from, to),
    loadLatestAttemptsByPhone(clientId, phones),
    JourneyRevenueAttribution.aggregate([
      {
        $match: {
          clientId,
          journeyType: 'cart_abandoned',
          attributedAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$amount' },
          orderCount: { $sum: 1 },
          orderKeys: { $addToSet: '$orderKey' },
        },
      },
    ]).exec().catch(() => []),
  ]);

  const journeyCartRevenue = journeyCartRevenueResult?.[0] || { totalRevenue: 0, orderCount: 0, orderKeys: [] };

  let totalAbandoned = 0;
  let recoveredCarts = 0;
  let organicRecovered = 0;
  let whatsappRecovered = 0;
  let revenueRecovered = 0;
  let revenueRecoveredFromWhatsapp = 0;
  let organicRevenue = 0;
  let valueSum = 0;

  const funnel = {
    msg1Sent: 0,
    msg2Sent: 0,
    msg3Sent: 0,
    recoveredAfterMsg1: 0,
    recoveredAfterMsg2: 0,
    recoveredAfterMsg3: 0,
    messageEfficiencyRate: 0,
  };

  const rows = [];
  const chartBuckets = includeChartBuckets ? new Map() : null;
  const _matchedOrderIds = new Set();

  for (const lead of cohort) {
    const matchedOrder = pickOrderForLead(lead, orderMaps);
    if (matchedOrder) {
      const mKey = matchedOrder.orderId || matchedOrder.orderNumber || matchedOrder._id;
      if (mKey) _matchedOrderIds.add(String(mKey));
    }
    const phoneKey = contactPhoneKey(lead.phoneNumber) || normalizePhoneKey(lead.phoneNumber);
    const attempt = attemptByPhone.get(phoneKey) || null;

    if (mode === 'activity') {
      const recovered = isRecovered(lead, matchedOrder, attempt);
      if (recovered && !leadInActivityWindow(lead, from, to, matchedOrder)) continue;
      if (!recovered && !leadInAbandonWindow(lead, from, to)) continue;
    }

    if (includeFunnel) {
      const sentSteps = collectSentSteps(lead);
      if (sentSteps.has(1)) funnel.msg1Sent += 1;
      if (sentSteps.has(2)) funnel.msg2Sent += 1;
      if (sentSteps.has(3)) funnel.msg3Sent += 1;
      trackFunnelRecovery(funnel, attempt, lead);
    }

    const items = normalizeItems(lead);
    const totals = cartTotals(items, lead.cartSnapshot || {}, lead);
    const recovered = isRecovered(lead, matchedOrder, attempt);

    totalAbandoned += 1;
    valueSum += totals.cartValue;

    if (recovered) {
      recoveredCarts += 1;
      const recoveredValue = sumRecoveredRevenue(lead, matchedOrder, attempt, totals);
      revenueRecovered += recoveredValue;

      if (attempt?.recoveredViaWhatsapp || isWaRecoveredLead(lead)) {
        whatsappRecovered += 1;
        revenueRecoveredFromWhatsapp += recoveredValue;
      } else {
        organicRecovered += 1;
        organicRevenue += recoveredValue;
      }
    }

    if (includeRows) {
      rows.push({
        id: String(lead._id),
        phoneNumber: lead.phoneNumber,
        email: lead.email || null,
        cartStatus: lead.cartStatus,
        cartValue: totals.cartValue,
        abandonedAt: abandonDate(lead),
        recovered,
        messaged: collectSentSteps(lead).size > 0,
        recoveredViaWhatsapp: Boolean(attempt?.recoveredViaWhatsapp || isWaRecoveredLead(lead)),
        recoveredRevenue: recovered ? sumRecoveredRevenue(lead, matchedOrder, attempt, totals) : 0,
        matchedOrderId: matchedOrder?.orderId || matchedOrder?.orderNumber || null,
      });
    }

    if (chartBuckets) {
      const abAt = abandonDate(lead);
      const bucketKey = chartBucketKey(abAt, chartBucketUnit);
      const messaged = collectSentSteps(lead).size > 0;
      bumpChartBucket(chartBuckets, bucketKey, { recovered, messaged });
    }
  }

  recoveredCarts = Math.min(recoveredCarts, totalAbandoned);

  if (whatsappMetrics.configured) {
    whatsappRecovered = Math.min(whatsappRecovered, recoveredCarts);
  }

  const recoveryRate =
    totalAbandoned > 0
      ? Math.round((recoveredCarts / totalAbandoned) * 10000) / 100
      : 0;

  const averageAbandonedCartValue =
    totalAbandoned > 0 ? Math.round((valueSum / totalAbandoned) * 100) / 100 : 0;

  if (includeFunnel && funnel.msg1Sent > 0) {
    funnel.messageEfficiencyRate =
      Math.round((recoveredCarts / funnel.msg1Sent) * 10000) / 100;
  }

  // Snapshot legacy-only totals before merging journey revenue
  const legacyRevenue = revenueRecovered;
  const legacyOrders = recoveredCarts;

  // Merge journey cart-recovery revenue (additive, deduplicated by orderKey)
  let journeyDeduplicatedRevenue = 0;
  let journeyDeduplicatedOrders = 0;
  if (journeyCartRevenue.totalRevenue > 0) {
    const uniqueJourneyKeys = (journeyCartRevenue.orderKeys || []).filter(
      (k) => !_matchedOrderIds.has(String(k))
    );
    if (uniqueJourneyKeys.length > 0) {
      journeyDeduplicatedRevenue =
        journeyCartRevenue.totalRevenue * (uniqueJourneyKeys.length / Math.max((journeyCartRevenue.orderKeys || []).length, 1));
      journeyDeduplicatedOrders = uniqueJourneyKeys.length;
      revenueRecovered += journeyDeduplicatedRevenue;
      revenueRecoveredFromWhatsapp += journeyDeduplicatedRevenue;
      whatsappRecovered += journeyDeduplicatedOrders;
      recoveredCarts += journeyDeduplicatedOrders;
    }
  }

  const result = {
    totalAbandoned,
    recoveredCarts,
    organicRecovered,
    whatsappRecovered,
    revenueRecovered,
    revenueRecoveredFromWhatsapp,
    organicRevenue,
    recoveryRate,
    averageAbandonedCartValue,
    funnel,
    journeyRevenue: {
      total: journeyCartRevenue.totalRevenue || 0,
      orders: journeyCartRevenue.orderCount || 0,
    },
    cartRecovery: {
      total: { revenue: revenueRecovered, orders: recoveredCarts },
      legacy: { revenue: legacyRevenue, orders: legacyOrders },
      journey: { revenue: journeyDeduplicatedRevenue, orders: journeyDeduplicatedOrders },
    },
    meta: {
      mode,
      from: from.toISOString(),
      to: to.toISOString(),
      timezone,
      computedAt: new Date().toISOString(),
      version: 'ssot-cohort-v2',
    },
  };

  if (includeRows) {
    result.rows = rows;
  }

  if (includeChartBuckets && chartBuckets) {
    result.chartBuckets = Array.from(chartBuckets.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );
  }

  if (!bypassCache) {
    writeRecoveryMetricsCache(cacheKey, result);
  }

  return result;
}

module.exports = {
  calculateRecoveryMetrics,
  isRecovered,
  buildAbandonCohort,
  buildOrderContactMap,
  pickOrderForLead,
  sumRecoveredRevenue,
  abandonDate,
  isRecoveredLead,
  dedupeLeadsForWorkspace,
  invalidateRecoveryMetricsCache: require('../utils/commerce/cartRecoveryMetricsCache')
    .invalidateRecoveryMetricsCache,
};
