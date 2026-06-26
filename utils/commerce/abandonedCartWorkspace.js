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
  loadLatestAttemptsByPhone,
  buildWhatsappFollowupDisplay,
  recoveryStatusFromAttempt,
  buildRecoveryTimeline,
  summarizeMessageEngagement,
} = require('./cartRecoveryAttemptService');
const { predictRecoveryValue } = require('./cartRecoveryPrediction');
const { CART_RECOVERY_STEP_PROBABILITIES } = require('../../constants/cartRecoveryDefaults');
const { buildConnectionStatusPayload } = require('../core/connectionStatus');
const { ABANDONED_CART_TAG, RECOVERED_CART_TAG } = require('../../constants/cartRecoveryTags');
const {
  reconcileOpenCartLeadsForClient,
  orderRecoversAbandonedLead,
  reconcileCartRecoveryFromShopifyOrder,
  shopifyPayloadFromOrder,
} = require('./cartRecoveryOrderReconcile');
const {
  getCartRecoveryDelays,
  getCartRecoveryConfig,
  computeNextPromotionAt,
  buildConfigPayload,
} = require('./cartRecoveryConfigService');
const { calculateRecoveryMetrics } = require('../../services/cartRecoveryMetricsService');

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
  const events = [];
  const seen = new Set();

  const push = (ev) => {
    if (!ev?.label) return;
    const key = `${ev.kind || 'evt'}:${ev.label}:${ev.at ? new Date(ev.at).toISOString() : 'na'}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(ev);
  };

  for (const ev of buildRecoveryTimeline(lead, attempt)) {
    push(ev);
  }

  if (isRecoveredLead(lead) && !events.some((e) => e.kind === 'recovered')) {
    const recoveredAt =
      lead.recoveredAt || lead.abandonedCartRecoveredAt || lead.lastPurchaseDate || null;
    if (recoveredAt) {
      push({
        at: recoveredAt,
        label: lead.recoveredViaWhatsApp ? 'Recovered via WhatsApp' : 'Order placed',
        kind: 'recovered',
      });
    }
  }

  if (lead.checkoutInitiatedAt) {
    push({
      at: lead.checkoutInitiatedAt,
      label: 'Started checkout',
      kind: 'checkout',
    });
  }

  for (const line of followup?.lines || []) {
    if (line?.text) push({ at: null, label: line.text, kind: line.tone || 'followup' });
  }

  return events
    .filter((e) => e.at || e.kind === 'abandon' || e.kind === 'recovered')
    .sort((a, b) => {
      if (!a.at) return 1;
      if (!b.at) return -1;
      return new Date(a.at) - new Date(b.at);
    });
}

function isPlaceholderPhone(phone) {
  const p = String(phone || '');
  return !p || p.startsWith('unknown_checkout_') || p.startsWith('unknown_email_');
}

function isNonRecoverableLead(lead) {
  return isPlaceholderPhone(lead?.phoneNumber);
}

function formatLeadContactDisplay(lead) {
  const phone = String(lead?.phoneNumber || '');
  if (isPlaceholderPhone(phone)) {
    if (lead?.email) return lead.email;
    return 'Contact pending';
  }
  return phone;
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

/** Collapse duplicate rows — checkout token, phone, email stub, or same session. */
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

const PLACEHOLDER_CUSTOMER_NAMES = new Set([
  '',
  'checkout customer',
  'guest',
  'guest shopper',
  'a customer',
  'customer',
  'shopify customer',
]);

function isPlaceholderCustomerName(name) {
  return PLACEHOLDER_CUSTOMER_NAMES.has(String(name || '').trim().toLowerCase());
}

function formatAddressBlock(addr = {}) {
  if (!addr || typeof addr !== 'object') return null;
  const line1 = String(addr.address1 || addr.line1 || '').trim();
  const line2 = String(addr.address2 || addr.line2 || '').trim();
  const city = String(addr.city || '').trim();
  const province = String(addr.province || addr.state || '').trim();
  const zip = String(addr.zip || addr.postal_code || '').trim();
  const country = String(addr.country || '').trim();
  const name = [addr.first_name, addr.last_name].filter(Boolean).join(' ').trim() || String(addr.name || '').trim();
  const phone = addr.phone ? String(addr.phone).trim() : null;
  if (!line1 && !city && !name && !phone) return null;
  const parts = [line1, line2, [city, province, zip].filter(Boolean).join(', '), country].filter(Boolean);
  return {
    name: name || null,
    phone,
    address1: line1 || null,
    address2: line2 || null,
    city: city || null,
    province: province || null,
    zip: zip || null,
    country: country || null,
    formatted: parts.join(', ') || null,
  };
}

function formatAddressBlockFromOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const shipping = order.shippingAddress && typeof order.shippingAddress === 'object'
    ? formatAddressBlock(order.shippingAddress)
    : null;
  if (shipping?.formatted) return shipping;
  const line1 = String(order.address || '').trim();
  const city = String(order.city || '').trim();
  const province = String(order.state || '').trim();
  const zip = String(order.zip || '').trim();
  if (!line1 && !city) return null;
  return formatAddressBlock({
    address1: line1,
    city,
    province,
    zip,
    name: order.customerName || order.name,
    phone: order.customerPhone || order.phone,
  });
}

function resolveCustomerName(lead, contact = {}, order = null) {
  const candidates = [
    lead?.name,
    contact?.name,
    contact?.shipping?.name,
    contact?.billing?.name,
    order?.customerName,
    order?.name,
    order?.shippingAddress?.name,
    [order?.shippingAddress?.first_name, order?.shippingAddress?.last_name].filter(Boolean).join(' '),
    order?.billingAddress?.name,
    [order?.billingAddress?.first_name, order?.billingAddress?.last_name].filter(Boolean).join(' '),
  ];
  for (const raw of candidates) {
    const name = String(raw || '').trim();
    if (name && !isPlaceholderCustomerName(name)) return name;
  }
  return 'Guest shopper';
}

function enrichContactFromOrder(contact = {}, order = null) {
  const next = { ...contact };
  if (!order) return next;

  const orderShipping = formatAddressBlockFromOrder(order);
  const orderBilling = order.billingAddress && typeof order.billingAddress === 'object'
    ? formatAddressBlock(order.billingAddress)
    : null;

  if (!next.shipping?.formatted && orderShipping?.formatted) next.shipping = orderShipping;
  if (!next.billing?.formatted && orderBilling?.formatted) next.billing = orderBilling;

  if (!next.email) next.email = order.customerEmail || order.email || null;
  if (!next.phone) next.phone = order.customerPhone || order.phone || null;
  if (isPlaceholderCustomerName(next.name)) {
    const resolved = resolveCustomerName(null, next, order);
    if (!isPlaceholderCustomerName(resolved)) next.name = resolved;
  }
  return next;
}

function buildCheckoutContact(lead, order = null) {
  const meta = lead?.meta && typeof lead.meta === 'object' ? lead.meta : {};
  const checkout = meta.checkoutContact && typeof meta.checkoutContact === 'object' ? meta.checkoutContact : {};
  const shipping = formatAddressBlock(checkout.shipping);
  const billing = formatAddressBlock(checkout.billing);
  const base = {
    name: lead?.name || checkout.name || shipping?.name || billing?.name || null,
    phone: lead?.phoneNumber && !isPlaceholderPhone(lead.phoneNumber) ? lead.phoneNumber : shipping?.phone || billing?.phone || null,
    email: lead?.email || checkout.email || null,
    shipping,
    billing,
    utmSource: lead?.utmSource || null,
    utmMedium: lead?.utmMedium || null,
    utmCampaign: lead?.utmCampaign || null,
    referrerDomain: lead?.referrerDomain || null,
    source: lead?.source || null,
  };
  return enrichContactFromOrder(base, order);
}

function resolveCustomerTags(lead, { recovered, nonRecoverable }) {
  const leadTags = Array.isArray(lead.tags) ? [...lead.tags] : [];
  if (recovered) {
    const withoutAbandon = leadTags.filter(
      (t) => String(t).trim().toLowerCase() !== ABANDONED_CART_TAG.toLowerCase()
    );
    if (!withoutAbandon.some((t) => String(t).trim().toLowerCase() === RECOVERED_CART_TAG.toLowerCase())) {
      return [...withoutAbandon, RECOVERED_CART_TAG];
    }
    return withoutAbandon;
  }
  if (!nonRecoverable && !leadTags.some((t) => String(t).trim().toLowerCase() === ABANDONED_CART_TAG.toLowerCase())) {
    return [...leadTags, ABANDONED_CART_TAG];
  }
  return leadTags;
}

async function ensureCartRecoveryTagsForLeads(leads = []) {
  if (!leads.length) return;
  /** One update per lead — duplicate rows caused Mongo "conflict at tags". */
  const byId = new Map();
  for (const lead of leads) {
    if (!lead?._id) continue;
    const id = String(lead._id);
    const tags = Array.isArray(lead.tags) ? lead.tags : [];
    if (isRecoveredLead(lead)) {
      if (!tags.some((t) => String(t).trim().toLowerCase() === RECOVERED_CART_TAG.toLowerCase())) {
        byId.set(id, {
          filter: { _id: lead._id },
          update: { $set: { tags: resolveCustomerTags(lead, { recovered: true, nonRecoverable: false }) } },
        });
      }
      continue;
    }
    if (byId.has(id)) continue;
    if (
      lead.cartStatus === 'abandoned' &&
      !isPlaceholderPhone(lead.phoneNumber) &&
      !tags.some((t) => String(t).trim().toLowerCase() === ABANDONED_CART_TAG.toLowerCase())
    ) {
      byId.set(id, {
        filter: { _id: lead._id },
        update: { $addToSet: { tags: ABANDONED_CART_TAG } },
      });
    }
  }
  const bulk = [...byId.values()].map((op) => ({ updateOne: op }));
  if (!bulk.length) return;
  await AdLead.bulkWrite(bulk, { ordered: false }).catch((err) => {
    log.warn(`[AbandonedCartWorkspace] tag backfill skipped: ${err.message}`);
  });
}

function normalizePhoneKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
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

function recoveryStatusLabel(lead) {
  if (lead.cartStatus === 'active' && lead.contactCapturedAt) {
    return { key: 'in_checkout', label: 'In checkout' };
  }
  if (isWaRecoveredLead(lead)) return { key: 'whatsapp', label: 'Recovered via WhatsApp' };
  if (isRecoveredLead(lead)) return { key: 'organic', label: 'Recovered at checkout' };
  return { key: 'active', label: 'Active abandoned' };
}

async function latestOrdersByPhone(clientId, phones = [], leadsByPhone = new Map()) {
  const suffixes = [...new Set(phones.map(normalizePhoneKey).filter((p) => p.length >= 8))];
  if (!suffixes.length) return new Map();

  const orders = await Order.find({ clientId })
    .sort({ createdAt: -1 })
    .select(
      'phone customerPhone customerName name customerEmail email orderId orderNumber shopifyOrderId financialStatus fulfillmentStatus status totalPrice amount createdAt address city state zip shippingAddress billingAddress checkoutToken'
    )
    .limit(5000)
    .lean();

  const candidates = new Map();
  for (const o of orders) {
    const key = normalizePhoneKey(o.customerPhone || o.phone);
    if (!key || !suffixes.includes(key)) continue;
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(o);
  }

  const map = new Map();
  for (const [key, list] of candidates) {
    const lead = leadsByPhone.get(key);
    const abandonAt = lead ? abandonDate(lead) : null;
    const recoveredId = String(lead?.recoveredOrderId || lead?.lastOrderId || '').trim();

    let pick = null;
    if (recoveredId) {
      pick = list.find((o) => {
        const ids = [o.orderId, o.orderNumber, o.shopifyOrderId].map((v) => String(v || '').replace(/^#/, '').trim());
        const rid = recoveredId.replace(/^#/, '').trim();
        return ids.some((id) => id && (id === rid || id.endsWith(rid) || rid.endsWith(id)));
      });
    }
    if (!pick && abandonAt) {
      const abandonMs = new Date(abandonAt).getTime() - 2 * 60 * 1000;
      pick = list.find((o) => o.createdAt && new Date(o.createdAt).getTime() >= abandonMs);
    }
    map.set(key, pick || list[0] || null);
  }
  return map;
}

function formatOrderRef(order, lead = null, attempt = null) {
  const candidates = [
    order?.orderNumber,
    order?.orderId,
    order?.shopifyOrderId,
    lead?.recoveredOrderId,
    lead?.lastOrderId,
    attempt?.recoveredOrderId,
    attempt?.shopifyOrderId,
  ];
  for (const raw of candidates) {
    const s = String(raw || '').replace(/^#/, '').trim();
    if (s) return s;
  }
  return null;
}

function buildRecoveredOrderPayload(lead, latestOrder, attempt, recovered) {
  if (!recovered) return null;

  const orderRef = formatOrderRef(latestOrder, lead, attempt);
  const totalPrice =
    Number(latestOrder?.totalPrice || latestOrder?.amount || 0) ||
    Number(attempt?.recoveredOrderValue || attempt?.recoveredOrderAmount || 0) ||
    Number(lead?.lifetimeValue || lead?.cartValue || 0);

  const createdAt =
    latestOrder?.createdAt ||
    attempt?.recoveredAt ||
    lead?.recoveredAt ||
    lead?.abandonedCartRecoveredAt ||
    lead?.lastPurchaseDate ||
    null;

  if (!orderRef && !totalPrice && !createdAt) return null;

  const shipping = formatAddressBlockFromOrder(latestOrder);

  return {
    orderNumber: orderRef || '',
    orderId: orderRef || String(latestOrder?._id || ''),
    shopifyOrderId: latestOrder?.shopifyOrderId || null,
    totalPrice,
    createdAt,
    recoveredViaWhatsapp: Boolean(attempt?.recoveredViaWhatsapp || isWaRecoveredLead(lead)),
    displayLabel: orderRef ? `Order #${orderRef}` : 'Order placed',
    customerName: latestOrder?.customerName || latestOrder?.name || shipping?.name || null,
    customerEmail: latestOrder?.customerEmail || latestOrder?.email || null,
    customerPhone: latestOrder?.customerPhone || latestOrder?.phone || null,
    shippingAddress: shipping,
  };
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

async function persistRecoveriesFromOrderMap(client, leads, orderMap) {
  if (!client?.clientId || !leads?.length || !orderMap?.size) return 0;
  let persisted = 0;
  for (const lead of leads) {
    if (isRecoveredLead(lead)) continue;
    const order = orderMap.get(normalizePhoneKey(lead.phoneNumber));
    if (!order || !orderRecoversAbandonedLead(order, lead)) continue;
    const out = await reconcileCartRecoveryFromShopifyOrder(
      client,
      shopifyPayloadFromOrder(order, lead),
      { source: 'workspace_order_map' }
    );
    if (out.matched && !out.duplicate && !out.error) persisted += 1;
  }
  return persisted;
}

async function buildAbandonedCartWorkspace(clientId, query = {}) {
  const { from, to, preset } = parseDateRange(query);
  const reconcileSince = new Date(Math.min(from.getTime(), Date.now() - 90 * 86400000));
  await reconcileOpenCartLeadsForClient(clientId, { since: reconcileSince, maxLeads: 400 }).catch((err) => {
    log.warn(`[AbandonedCartWorkspace] recovery reconcile skipped: ${err.message}`);
  });

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
    .select(
      'phoneNumber name email cartStatus cartSnapshot cartValue cartAbandonedAt contactCapturedAt lastCartEventAt lastInteraction createdAt updatedAt isOrderPlaced recoveryStep recoveryStartedAt abandonedCartRecoveredAt recoveredViaWhatsApp activityLog addToCartCount checkoutInitiatedCount checkoutInitiatedAt checkoutToken tags nextPromotionAt nextAllowedSendAt cartValueTier recoveryUrl exitIntentAt visitorFirstVisitAt visitorVisitCount meta utmSource utmMedium utmCampaign referrerDomain source recoveredAt recoveredOrderId lastOrderId lastPurchaseDate lifetimeValue totalSpent'
    )
    .limit(8000)
    .lean();

  const filtered = dedupeLeadsForWorkspace(
    leads.filter((l) => isAbandonCandidate(l) && leadInAbandonWindow(l, from, to))
  );
  const phones = filtered.map((l) => l.phoneNumber);
  const leadsByPhone = new Map();
  for (const lead of filtered) {
    const key = normalizePhoneKey(lead.phoneNumber);
    if (key.length >= 8 && !isPlaceholderPhone(lead.phoneNumber)) {
      leadsByPhone.set(key, lead);
    }
  }
  const orderMap = await latestOrdersByPhone(clientId, phones, leadsByPhone);

  const persisted = await persistRecoveriesFromOrderMap(client, filtered, orderMap).catch((err) => {
    log.warn(`[AbandonedCartWorkspace] order-map reconcile skipped: ${err.message}`);
    return 0;
  });

  let workingLeads = filtered;
  if (persisted > 0) {
    const refreshed = await AdLead.find({
      clientId,
      _id: { $in: filtered.map((l) => l._id) },
    })
      .select(
        'phoneNumber name email cartStatus cartSnapshot cartValue cartAbandonedAt contactCapturedAt lastCartEventAt lastInteraction createdAt updatedAt isOrderPlaced recoveryStep recoveryStartedAt abandonedCartRecoveredAt recoveredViaWhatsApp activityLog addToCartCount checkoutInitiatedCount checkoutInitiatedAt checkoutToken tags nextPromotionAt nextAllowedSendAt cartValueTier recoveryUrl exitIntentAt visitorFirstVisitAt visitorVisitCount recoveredAt lastPurchaseDate lifetimeValue totalSpent recoveredOrderId lastOrderId meta utmSource utmMedium utmCampaign referrerDomain source'
      )
      .lean();
    const byId = new Map(refreshed.map((l) => [String(l._id), l]));
    workingLeads = filtered.map((l) => byId.get(String(l._id)) || l);
  }

  const [followupConfig, whatsappMetrics, attemptByPhone] = await Promise.all([
    getCartFollowupConfig(clientId),
    getWhatsappRecoveryMetrics(clientId, from, to),
    loadLatestAttemptsByPhone(clientId, phones),
  ]);

  ensureCartRecoveryTagsForLeads(workingLeads).catch(() => {});

  const canonical = await calculateRecoveryMetrics(clientId, {
    from,
    to,
    mode: 'cohort',
    includeFunnel: true,
    includeRows: false,
    reconcileFirst: false,
    persistOrderMap: false,
  });

  const rows = [];
  let metrics = {
    totalAbandoned: canonical.totalAbandoned,
    activeAbandoned: 0,
    recoverableRevenue: 0,
    nonRecoverableCount: 0,
    recoveredCarts: canonical.recoveredCarts,
    revenueRecovered: canonical.revenueRecovered,
    recoveredFromWhatsapp: canonical.whatsappRecovered,
    revenueRecoveredFromWhatsapp: canonical.revenueRecoveredFromWhatsapp,
    organicRecovered: canonical.organicRecovered,
    organicRevenue: canonical.organicRevenue,
    linkClicks: 0,
    buttonClicks: 0,
    averageAbandonedCartValue: canonical.averageAbandonedCartValue,
    recoveryRate: canonical.recoveryRate,
  };

  let unknownPhoneCount = 0;
  const funnel = {
    msg1Sent: canonical.funnel.msg1Sent,
    msg2Sent: canonical.funnel.msg2Sent,
    msg3Sent: canonical.funnel.msg3Sent,
    recoveredAfterMsg1: canonical.funnel.recoveredAfterMsg1,
    recoveredAfterMsg2: canonical.funnel.recoveredAfterMsg2,
    recoveredAfterMsg3: canonical.funnel.recoveredAfterMsg3,
  };
  const { delay1Min, promotionDelayMin } = getCartRecoveryDelays(client || {});

  for (const lead of workingLeads) {
    const nonRecoverable = isNonRecoverableLead(lead);
    if (nonRecoverable) {
      unknownPhoneCount += 1;
      metrics.nonRecoverableCount += 1;
    }

    const phoneKey = contactPhoneKey(lead.phoneNumber) || normalizePhoneKey(lead.phoneNumber);
    const attempt = attemptByPhone.get(phoneKey) || null;

    const items = normalizeItems(lead);
    const totals = cartTotals(items, lead.cartSnapshot || {}, lead);
    const phoneKeyOrder = normalizePhoneKey(lead.phoneNumber);
    const latestOrder = orderMap.get(phoneKeyOrder) || null;
    const orderRecovered = orderRecoversAbandonedLead(latestOrder, lead);
    const recovered =
      attempt?.status === 'recovered' || isRecoveredLead(lead) || orderRecovered;
    const active = !recovered;

    if (active) {
      if (!nonRecoverable) {
        metrics.activeAbandoned += 1;
        metrics.recoverableRevenue += totals.cartValue;
      }
    }

    const followup = buildWhatsappFollowupDisplay(
      attempt,
      followupConfig,
      Number(lead.recoveryStep || 0),
      lead
    );
    let recovery = recoveryStatusFromAttempt(attempt, lead);
    if (orderRecovered && recovery.key === 'active') {
      recovery = { key: 'organic', label: 'Recovered at checkout' };
    }

    const engagement = summarizeMessageEngagement(attempt);
    metrics.linkClicks += engagement.linkClicks;
    metrics.buttonClicks += engagement.buttonClicks;
    const recoveryStepNum = Number(lead.recoveryStep || 0);
    const stepClamped = Math.min(3, Math.max(0, recoveryStepNum));
    const recoveryProbability =
      CART_RECOVERY_STEP_PROBABILITIES[stepClamped] ?? CART_RECOVERY_STEP_PROBABILITIES[0];
    const isInCheckout = lead.cartStatus === 'active' && !!lead.contactCapturedAt;
    const canShowPredicted = active && !nonRecoverable && !isInCheckout;
    const leadTags = resolveCustomerTags(lead, { recovered, nonRecoverable });
    const checkoutContact = buildCheckoutContact(lead, latestOrder);
    const displayName = resolveCustomerName(lead, checkoutContact, latestOrder);

    rows.push({
      id: String(lead._id),
      customer: {
        name: displayName,
        phone: lead.phoneNumber,
        email: lead.email || checkoutContact.email || latestOrder?.customerEmail || latestOrder?.email || null,
        phoneDisplay: formatLeadContactDisplay(lead),
        tags: leadTags,
        contact: checkoutContact,
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
      recoveryStep: recoveryStepNum,
      predictedRecoveryValue: canShowPredicted
        ? predictRecoveryValue(totals.cartValue, recoveryStepNum)
        : 0,
      predictedRecoveryPct: Math.round(recoveryProbability * 1000) / 10,
      predictedRecoveryStep: stepClamped,
      showPredictedRecovery: canShowPredicted,
      isInCheckout,
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
      recoveredOrder: buildRecoveredOrderPayload(lead, latestOrder, attempt, recovered),
    });
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

  const leads = await AdLead.find({
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
    .select(
      'phoneNumber email cartStatus cartSnapshot cartValue cartAbandonedAt contactCapturedAt lastCartEventAt lastInteraction createdAt updatedAt checkoutToken addToCartCount'
    )
    .limit(8000)
    .lean();

  const filtered = dedupeLeadsForWorkspace(
    leads.filter((l) => isAbandonCandidate(l) && leadInAbandonWindow(l, from, to))
  );

  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const cellMeta = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({
      carts: 0,
      totalItems: 0,
      itemBuckets: {},
    }))
  );
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (const lead of filtered) {
    const abandonAt = abandonDate(lead);
    if (!abandonAt) continue;
    const istMs = new Date(abandonAt).getTime() + 5.5 * 60 * 60 * 1000;
    const ist = new Date(istMs);
    const dow = ist.getUTCDay();
    const hour = ist.getUTCHours();

    const items = normalizeItems(lead);
    const itemCount = items.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    const bucket = itemCount <= 1 ? '1' : itemCount === 2 ? '2' : itemCount === 3 ? '3' : '4+';

    grid[dow][hour] += 1;
    const meta = cellMeta[dow][hour];
    meta.carts += 1;
    meta.totalItems += itemCount;
    meta.itemBuckets[bucket] = (meta.itemBuckets[bucket] || 0) + 1;
  }

  const flat = grid.flat();
  const max = Math.max(...flat, 1);
  const peak = flat.reduce(
    (best, count, idx) => (count > best.count ? { count, dow: Math.floor(idx / 24), hour: idx % 24 } : best),
    { count: 0, dow: 0, hour: 0 }
  );

  return {
    success: true,
    range: { from, to, preset },
    timezone: 'Asia/Kolkata',
    dayLabels,
    hourLabels: Array.from({ length: 24 }, (_, i) => i),
    grid,
    cellMeta,
    max,
    total: filtered.length,
    peak: {
      count: peak.count,
      dow: peak.dow,
      hour: peak.hour,
      day: dayLabels[peak.dow],
      label: `${dayLabels[peak.dow]} ${peak.hour}:00 IST`,
    },
  };
}

module.exports = {
  parseDateRange,
  getRecoverySchedule,
  buildAbandonedCartWorkspace,
  buildAbandonHeatmap,
};
