'use strict';

const AdLead = require('../../models/AdLead');
const Order = require('../../models/Order');
const Conversation = require('../../models/Conversation');
const {
  normalizeLeadForDisplay,
  hasShopifyOrderSignal,
  hasWhatsAppInbound,
  resolveAcquisitionSource,
} = require('./leadDisplayNormalize');
const { findOrdersForLead } = require('../customer360/leadLookupHelpers');
const { phoneVariants } = require('../messaging/cancelAllAutomationsFor');
const { phoneSuffixKey } = require('../shopify/customerOrderAttribution');
const { pickCanonicalPhone, phoneForAdLeadStorage, isShopifyTestPhone } = require('../core/phoneSanitizer');

const LEAD_LIST_PROJECTION = {
  name: 1,
  phoneNumber: 1,
  leadScore: 1,
  tags: 1,
  lastInteraction: 1,
  chatSummary: 1,
  cartStatus: 1,
  lastMessageContent: 1,
  lastInboundAt: 1,
  linkClicks: 1,
  email: 1,
  ordersCount: 1,
  totalSpent: 1,
  intentState: 1,
  addToCartCount: 1,
  meta: 1,
  createdAt: 1,
  pendingSupport: 1,
  lastPurchaseDate: 1,
  source: 1,
  adAttribution: 1,
  cartValue: 1,
  lifetimeValue: 1,
  checkoutInitiatedCount: 1,
  optInSource: 1,
  optStatus: 1,
  inboundMessageCount: 1,
  importBatchId: 1,
  isOrderPlaced: 1,
  channelConsent: 1,
  lastOrderAt: 1,
};

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyLeadScoreStage(query, stage) {
  const s = String(stage || '').toLowerCase();
  if (!s) return;
  const existing = query.leadScore && typeof query.leadScore === 'object' ? { ...query.leadScore } : {};
  if (s === 'hot') {
    query.leadScore = { ...existing, $gte: Math.max(existing.$gte ?? 0, 80) };
  } else if (s === 'warm') {
    query.leadScore = {
      ...existing,
      $gte: Math.max(existing.$gte ?? 0, 50),
      $lt: existing.$lt != null ? Math.min(existing.$lt, 80) : 80,
    };
  } else if (s === 'cold') {
    query.leadScore = { ...existing, $lt: existing.$lt != null ? Math.min(existing.$lt, 50) : 50 };
  }
}

function buildLeadsListQuery(
  clientId,
  { search, tag, segmentScore, lastSeen, importBatchId, optStatus, hasPhone, source, stage, engagement, convStatus }
) {
  const query = { clientId };
  if (importBatchId) {
    query.importBatchId = importBatchId;
  }
  if (optStatus) {
    const status = String(optStatus).trim().toLowerCase();
    if (['opted_in', 'opted_out', 'unknown', 'pending'].includes(status)) {
      query.optStatus = status;
    }
  }
  if (hasPhone === true || String(hasPhone).toLowerCase() === 'true') {
    query.phoneNumber = { $exists: true, $type: 'string', $regex: /\S/ };
  }
  if (search) {
    const searchRegex = new RegExp(search, 'i');
    query.$and = (query.$and || []).concat([
      { $or: [{ name: searchRegex }, { phoneNumber: searchRegex }, { email: searchRegex }] },
    ]);
  }
  if (tag) query.tags = tag;
  if (source) {
    const src = String(source).trim().toLowerCase();
    if (src === 'import' || src === 'csv_import') {
      query.$and = (query.$and || []).concat([
        {
          $or: [
            { source: { $regex: /^csv_import$/i } },
            { importBatchId: { $exists: true, $ne: null } },
          ],
        },
      ]);
    } else {
      query.source = { $regex: new RegExp(`^${escapeRegex(source)}$`, 'i') };
    }
  }
  if (segmentScore) {
    const [min, max] = segmentScore.split('-').map(Number);
    if (!Number.isNaN(min) && !Number.isNaN(max)) query.leadScore = { $gte: min, $lte: max };
  }
  applyLeadScoreStage(query, stage);
  const engagementKey = String(engagement || '').toLowerCase();
  if (engagementKey === 'high') {
    query.linkClicks = { $gt: 5 };
  } else if (engagementKey === 'medium') {
    query.linkClicks = { $gte: 1, $lte: 5 };
  } else if (engagementKey === 'low') {
    query.$and = (query.$and || []).concat([
      { $or: [{ linkClicks: { $exists: false } }, { linkClicks: 0 }] },
    ]);
  }
  const convKey = String(convStatus || '').toLowerCase();
  if (convKey === 'has_conv') {
    query.$and = (query.$and || []).concat([
      {
        $or: [
          { chatSummary: { $exists: true, $nin: [null, ''] } },
          { lastMessageContent: { $exists: true, $nin: [null, ''] } },
        ],
      },
    ]);
  } else if (convKey === 'no_conv') {
    query.$and = (query.$and || []).concat([
      {
        $and: [
          { $or: [{ chatSummary: { $exists: false } }, { chatSummary: null }, { chatSummary: '' }] },
          { $or: [{ lastMessageContent: { $exists: false } }, { lastMessageContent: null }, { lastMessageContent: '' }] },
        ],
      },
    ]);
  }
  if (lastSeen) {
    const days =
      lastSeen === '24h' ? 1 : lastSeen === '7d' ? 7 : lastSeen === '14d' ? 14 : lastSeen === '1m' ? 30 : lastSeen === '6m' ? 180 : 0;
    if (days > 0) {
      const date = new Date();
      date.setDate(date.getDate() - days);
      query.lastInteraction = { $gte: date };
    }
  }
  return query;
}

function sortStage(sortBy) {
  const key = sortBy === 'spend' ? 'ltv' : sortBy;
  if (key === 'score') return { leadScore: -1, _id: -1 };
  if (key === 'ltv') return { totalSpent: -1, _id: -1 };
  if (key === 'name') return { name: 1, _id: -1 };
  if (key === 'clicks') return { linkClicks: -1, _id: -1 };
  if (key === 'lastPurchase') return { lastPurchaseDate: -1, _id: -1 };
  if (key === 'orders') return { ordersCount: -1, _id: -1 };
  if (key === 'cartValue') return { cartValue: -1, _id: -1 };
  return { lastInteraction: -1, _id: -1 };
}

function leadsPagePipeline(query, sortBy, skip, limitNum) {
  const normalizedSort = sortBy === 'spend' ? 'ltv' : sortBy;
  if (normalizedSort === 'aov') {
    return [
      { $match: query },
      {
        $addFields: {
          __aovSort: {
            $cond: {
              if: { $gt: ['$ordersCount', 0] },
              then: { $divide: [{ $ifNull: ['$totalSpent', 0] }, '$ordersCount'] },
              else: 0,
            },
          },
        },
      },
      { $sort: { __aovSort: -1, _id: -1 } },
      { $skip: skip },
      { $limit: limitNum },
      { $project: { ...LEAD_LIST_PROJECTION, __aovSort: 0 } },
    ];
  }
  return [
    { $match: query },
    { $sort: sortStage(normalizedSort) },
    { $skip: skip },
    { $limit: limitNum },
    { $project: LEAD_LIST_PROJECTION },
  ];
}

async function enrichLeadRow(clientId, row) {
  if (!row?.phoneNumber) return normalizeLeadForDisplay(row);

  const variants = phoneVariants(row.phoneNumber);
  const [orders, conversation] = await Promise.all([
    findOrdersForLead(clientId, row.phoneNumber, { limit: 50, email: row.email }),
    variants.length
      ? Conversation.findOne(
          { clientId, phone: { $in: variants } },
          { lastMessageAt: 1 }
        ).lean()
      : Promise.resolve(null),
  ]);

  let merged = row;
  if (conversation?.lastMessageAt) {
    merged = { ...row, conversationLastMessageAt: conversation.lastMessageAt };
  }

  const normalized = normalizeLeadForDisplay(merged, { orders });

  if (conversation?.lastMessageAt) {
    const convMs = new Date(conversation.lastMessageAt).getTime();
    const seenMs = normalized.displayLastSeenAt
      ? new Date(normalized.displayLastSeenAt).getTime()
      : 0;
    if (convMs > seenMs) {
      normalized.displayLastSeenAt = conversation.lastMessageAt;
      normalized.lastMessageAt = conversation.lastMessageAt;
    }
  }

  return normalized;
}

function shouldUseOrderBackedAudience(opts = {}) {
  if (opts.importBatchId) return false;
  const src = String(opts.source || '').trim().toLowerCase();
  if (src === 'import' || src === 'csv_import') return false;
  if (opts.includeAll === true || String(opts.includeAll).toLowerCase() === 'true') return false;
  return true;
}

function resolveDisplayPhone(order) {
  const raw = order.customerPhone || order.phone;
  if (!raw || isShopifyTestPhone(raw)) return null;
  const canonical = pickCanonicalPhone([order.customerPhone, order.phone], { country: 'IN' });
  const storage = phoneForAdLeadStorage(canonical || raw, 'IN');
  return storage || String(raw).trim();
}

async function loadOrderBackedCustomerRows(clientId) {
  const orders = await Order.find({ clientId })
    .select(
      'customerName customerPhone phone customerEmail email totalPrice amount createdAt shopifyOrderId orderNumber'
    )
    .sort({ createdAt: -1 })
    .limit(15000)
    .lean();

  const bySuffix = new Map();

  for (const order of orders) {
    const phoneNumber = resolveDisplayPhone(order);
    if (!phoneNumber) continue;
    const suffix = phoneSuffixKey(phoneNumber);
    if (!suffix) continue;

    const amount = parseFloat(order.totalPrice ?? order.amount ?? 0) || 0;
    const orderAt = order.createdAt ? new Date(order.createdAt) : null;
    const existing = bySuffix.get(suffix);

    if (!existing) {
      bySuffix.set(suffix, {
        phoneSuffix: suffix,
        phoneNumber,
        name: String(order.customerName || '').trim() || 'Customer',
        email: String(order.customerEmail || order.email || '').trim(),
        ordersCount: 1,
        totalSpent: amount,
        lastPurchaseDate: order.createdAt || null,
        lastOrderAt: order.createdAt || null,
        isOrderPlaced: true,
        source: 'shopify',
        _latestOrderAt: orderAt,
      });
      continue;
    }

    existing.ordersCount += 1;
    existing.totalSpent += amount;
    if (orderAt && (!existing._latestOrderAt || orderAt > existing._latestOrderAt)) {
      existing._latestOrderAt = orderAt;
      existing.lastPurchaseDate = order.createdAt;
      existing.lastOrderAt = order.createdAt;
      const nm = String(order.customerName || '').trim();
      if (nm.length > 2) existing.name = nm;
    }
    if (!existing.email) {
      const em = String(order.customerEmail || order.email || '').trim();
      if (em) existing.email = em;
    }
  }

  return [...bySuffix.values()].map(({ _latestOrderAt, ...row }) => row);
}

function mergeOrderRowWithLead(orderCustomer, lead, clientId) {
  if (lead) {
    return normalizeLeadForDisplay({
      ...lead,
      name: orderCustomer.name || lead.name,
      phoneNumber: orderCustomer.phoneNumber,
      email: orderCustomer.email || lead.email,
      ordersCount: orderCustomer.ordersCount,
      totalSpent: orderCustomer.totalSpent,
      lifetimeValue: orderCustomer.totalSpent,
      lastPurchaseDate: orderCustomer.lastPurchaseDate,
      lastOrderAt: orderCustomer.lastOrderAt,
      isOrderPlaced: true,
      source: lead.source || 'shopify',
    });
  }
  return normalizeLeadForDisplay({
    _id: `order_${orderCustomer.phoneSuffix}`,
    clientId,
    name: orderCustomer.name,
    phoneNumber: orderCustomer.phoneNumber,
    email: orderCustomer.email,
    ordersCount: orderCustomer.ordersCount,
    totalSpent: orderCustomer.totalSpent,
    lifetimeValue: orderCustomer.totalSpent,
    lastPurchaseDate: orderCustomer.lastPurchaseDate,
    lastOrderAt: orderCustomer.lastOrderAt,
    isOrderPlaced: true,
    source: 'shopify',
    leadScore: 0,
    tags: [],
    optStatus: 'unknown',
  });
}

async function loadWhatsAppOnlyLeadRows(clientId, orderSuffixSet) {
  const leads = await AdLead.find({
    clientId,
    phoneNumber: { $exists: true, $nin: ['', null] },
    $or: [
      { inboundMessageCount: { $gt: 0 } },
      { lastInboundAt: { $exists: true, $ne: null } },
      { chatSummary: { $exists: true, $nin: ['', null] } },
      { lastMessageContent: { $exists: true, $nin: ['', null] } },
    ],
  })
    .select(LEAD_LIST_PROJECTION)
    .limit(8000)
    .lean();

  const out = [];
  for (const lead of leads) {
    if (!lead?.phoneNumber || isShopifyTestPhone(lead.phoneNumber)) continue;
    const suffix = phoneSuffixKey(lead.phoneNumber);
    if (!suffix || orderSuffixSet.has(suffix)) continue;
    if (!hasWhatsAppInbound(lead)) continue;
    out.push(normalizeLeadForDisplay(lead));
  }
  return out;
}

/**
 * Resolve a lead doc for Customer 360 — supports Mongo AdLead ids and synthetic order_{suffix} ids.
 */
async function resolveAudienceLeadById(clientId, id) {
  const rawId = String(id || '').trim();
  if (!rawId || !clientId) return null;

  if (/^[0-9a-fA-F]{24}$/.test(rawId)) {
    const lead = await AdLead.findOne({ _id: rawId, clientId }).lean();
    if (lead) return lead;
  }

  const suffix = rawId.startsWith('order_') ? rawId.slice('order_'.length) : phoneSuffixKey(rawId);
  if (!suffix || suffix.length < 8) return null;

  const orderRows = await loadOrderBackedCustomerRows(clientId);
  const orderCustomer = orderRows.find((r) => r.phoneSuffix === suffix);
  if (!orderCustomer) return null;

  const phoneRegex = new RegExp(`${suffix}$`);
  const adLead = await AdLead.findOne({
    clientId,
    phoneNumber: phoneRegex,
  })
    .lean();

  if (adLead) {
    return {
      ...adLead,
      name: orderCustomer.name || adLead.name,
      phoneNumber: orderCustomer.phoneNumber,
      email: orderCustomer.email || adLead.email,
      ordersCount: orderCustomer.ordersCount,
      totalSpent: orderCustomer.totalSpent,
      lifetimeValue: orderCustomer.totalSpent,
      lastPurchaseDate: orderCustomer.lastPurchaseDate,
      lastOrderAt: orderCustomer.lastOrderAt,
      isOrderPlaced: true,
    };
  }

  return {
    _id: `order_${suffix}`,
    clientId,
    name: orderCustomer.name,
    phoneNumber: orderCustomer.phoneNumber,
    email: orderCustomer.email,
    ordersCount: orderCustomer.ordersCount,
    totalSpent: orderCustomer.totalSpent,
    lifetimeValue: orderCustomer.totalSpent,
    lastPurchaseDate: orderCustomer.lastPurchaseDate,
    lastOrderAt: orderCustomer.lastOrderAt,
    isOrderPlaced: true,
    source: 'shopify',
    leadScore: 0,
    tags: [],
    optStatus: 'unknown',
  };
}

function applyOrderBackedFilters(rows, opts = {}) {
  const {
    search = '',
    tag,
    segmentScore,
    lastSeen,
    stage,
    engagement,
    convStatus,
    optStatus,
    source,
  } = opts;

  let out = rows;

  if (search) {
    const q = String(search).trim().toLowerCase();
    out = out.filter(
      (r) =>
        String(r.name || '').toLowerCase().includes(q) ||
        String(r.phoneNumber || '').toLowerCase().includes(q) ||
        String(r.email || '').toLowerCase().includes(q)
    );
  }

  if (tag) {
    out = out.filter((r) => Array.isArray(r.tags) && r.tags.includes(tag));
  }

  if (segmentScore) {
    const [min, max] = String(segmentScore).split('-').map(Number);
    if (!Number.isNaN(min) && !Number.isNaN(max)) {
      out = out.filter((r) => {
        const s = Number(r.leadScore) || 0;
        return s >= min && s <= max;
      });
    }
  }

  const stageKey = String(stage || '').toLowerCase();
  if (stageKey === 'hot') out = out.filter((r) => (Number(r.leadScore) || 0) >= 80);
  else if (stageKey === 'warm') {
    out = out.filter((r) => {
      const s = Number(r.leadScore) || 0;
      return s >= 50 && s < 80;
    });
  } else if (stageKey === 'cold') out = out.filter((r) => (Number(r.leadScore) || 0) < 50);

  const engagementKey = String(engagement || '').toLowerCase();
  if (engagementKey === 'high') out = out.filter((r) => (Number(r.linkClicks) || 0) > 5);
  else if (engagementKey === 'medium') {
    out = out.filter((r) => {
      const c = Number(r.linkClicks) || 0;
      return c >= 1 && c <= 5;
    });
  } else if (engagementKey === 'low') out = out.filter((r) => (Number(r.linkClicks) || 0) === 0);

  const convKey = String(convStatus || '').toLowerCase();
  if (convKey === 'has_conv') {
    out = out.filter(
      (r) =>
        String(r.chatSummary || r.lastMessageContent || '').trim().length > 0 ||
        Number(r.inboundMessageCount) > 0
    );
  } else if (convKey === 'no_conv') {
    out = out.filter(
      (r) =>
        !String(r.chatSummary || r.lastMessageContent || '').trim() &&
        !(Number(r.inboundMessageCount) > 0)
    );
  }

  if (optStatus) {
    const status = String(optStatus).trim().toLowerCase();
    out = out.filter((r) => String(r.optStatus || 'unknown').toLowerCase() === status);
  }

  const sourceKey = String(source || '').trim().toLowerCase();
  if (sourceKey === 'shopify') {
    out = out.filter((r) => hasShopifyOrderSignal(r));
  } else if (sourceKey === 'whatsapp') {
    out = out.filter((r) => hasWhatsAppInbound(r));
  } else if (sourceKey === 'both') {
    out = out.filter((r) => hasShopifyOrderSignal(r) && hasWhatsAppInbound(r));
  } else if (sourceKey === 'import' || sourceKey === 'csv_import') {
    out = out.filter(
      (r) =>
        Boolean(r.importBatchId) ||
        (Array.isArray(r.tags) && r.tags.some((t) => /^import/i.test(String(t || ''))))
    );
  } else if (sourceKey === 'website') {
    out = out.filter((r) => {
      const key = String(resolveAcquisitionSource(r) || '').toLowerCase();
      return key.includes('website') || key.includes('widget');
    });
  } else if (sourceKey) {
    out = out.filter((r) => String(resolveAcquisitionSource(r) || '').toLowerCase() === sourceKey);
  }

  if (lastSeen) {
    const days =
      lastSeen === '24h' ? 1 : lastSeen === '7d' ? 7 : lastSeen === '14d' ? 14 : lastSeen === '1m' ? 30 : lastSeen === '6m' ? 180 : 0;
    if (days > 0) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      out = out.filter((r) => {
        const seen = r.lastInteraction || r.lastInboundAt || r.lastPurchaseDate;
        return seen && new Date(seen) >= since;
      });
    }
  }

  return out;
}

function sortOrderBackedRows(rows, sortBy) {
  const key = sortBy === 'spend' ? 'ltv' : sortBy;
  const list = [...rows];
  const cmp = (a, b) => {
    if (key === 'score') return (Number(b.leadScore) || 0) - (Number(a.leadScore) || 0);
    if (key === 'ltv' || key === 'spend') return (Number(b.totalSpent) || 0) - (Number(a.totalSpent) || 0);
    if (key === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
    if (key === 'clicks') return (Number(b.linkClicks) || 0) - (Number(a.linkClicks) || 0);
    if (key === 'lastPurchase') {
      return new Date(b.lastPurchaseDate || 0) - new Date(a.lastPurchaseDate || 0);
    }
    if (key === 'orders') return (Number(b.ordersCount) || 0) - (Number(a.ordersCount) || 0);
    if (key === 'cartValue') return (Number(b.cartValue) || 0) - (Number(a.cartValue) || 0);
    if (key === 'aov') {
      const aAov = (Number(a.ordersCount) || 0) > 0 ? (Number(a.totalSpent) || 0) / a.ordersCount : 0;
      const bAov = (Number(b.ordersCount) || 0) > 0 ? (Number(b.totalSpent) || 0) / b.ordersCount : 0;
      return bAov - aAov;
    }
    const aSeen = new Date(a.lastInteraction || a.lastInboundAt || a.lastPurchaseDate || 0).getTime();
    const bSeen = new Date(b.lastInteraction || b.lastInboundAt || b.lastPurchaseDate || 0).getTime();
    return bSeen - aSeen;
  };
  list.sort(cmp);
  return list;
}

/**
 * Unified audience: Shopify order customers + WhatsApp live-chat contacts (deduped by phone).
 */
async function fetchOrderBackedAudienceBundle(clientId, opts = {}) {
  const {
    search = '',
    tag,
    segmentScore,
    lastSeen,
    sortBy,
    page = 1,
    limit = 20,
    optStatus,
    stage,
    engagement,
    convStatus,
    source,
  } = opts;

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = Math.min(parseInt(limit, 10) || 20, 500);

  const orderRows = await loadOrderBackedCustomerRows(clientId);
  const suffixSet = new Set(orderRows.map((r) => r.phoneSuffix).filter(Boolean));

  const adLeadRows = await AdLead.find({
    clientId,
    phoneNumber: { $exists: true, $ne: '' },
  })
    .select(LEAD_LIST_PROJECTION)
    .lean();

  const leadBySuffix = new Map();
  for (const lead of adLeadRows) {
    const suffix = phoneSuffixKey(lead.phoneNumber);
    if (!suffix) continue;
    if (!leadBySuffix.has(suffix)) leadBySuffix.set(suffix, lead);
  }

  const shopifyMerged = orderRows.map((orderCustomer) =>
    mergeOrderRowWithLead(orderCustomer, leadBySuffix.get(orderCustomer.phoneSuffix), clientId)
  );

  const whatsappOnly = await loadWhatsAppOnlyLeadRows(clientId, suffixSet);

  let merged = [...shopifyMerged, ...whatsappOnly];

  merged = applyOrderBackedFilters(merged, {
    search,
    tag,
    segmentScore,
    lastSeen,
    stage,
    engagement,
    convStatus,
    optStatus,
    source,
  });
  merged = sortOrderBackedRows(merged, sortBy);

  const total = merged.length;
  const totalPages = Math.max(1, Math.ceil(total / limitNum));
  const safePage = Math.min(pageNum, totalPages);
  const skip = (safePage - 1) * limitNum;
  const pageSlice = merged.slice(skip, skip + limitNum);

  const leads = await Promise.all(
    pageSlice.map((row) => enrichLeadRow(clientId, row))
  );

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const activeToday = merged.filter((r) => r.lastInboundAt && new Date(r.lastInboundAt) >= dayStart).length;
  const withConversation = merged.filter(
    (r) =>
      hasWhatsAppInbound(r)
  ).length;
  const highEngagement = merged.filter((r) => (Number(r.linkClicks) || 0) > 5).length;
  const shopifyCustomers = merged.filter((r) => hasShopifyOrderSignal(r)).length;
  const whatsappContacts = merged.filter((r) => hasWhatsAppInbound(r)).length;
  const bothChannels = merged.filter(
    (r) => hasShopifyOrderSignal(r) && hasWhatsAppInbound(r)
  ).length;

  return {
    leads,
    currentPage: safePage,
    totalPages,
    totalLeads: total,
    summary: {
      activeToday,
      activeInPeriod: activeToday,
      withConversation,
      highEngagement,
      shopifyCustomers,
      whatsappContacts,
      bothChannels,
    },
    pagination: { page: safePage, limit: limitNum, total, totalPages },
    audienceSource: 'unified',
  };
}

/**
 * Single round-trip: filtered page + total + workspace summary counts.
 */
async function fetchLeadsAnalyticsBundle(clientId, opts = {}) {
  if (shouldUseOrderBackedAudience(opts)) {
    return fetchOrderBackedAudienceBundle(clientId, opts);
  }

  const {
    search = '',
    tag,
    segmentScore,
    lastSeen,
    sortBy,
    page = 1,
    limit = 20,
    importBatchId = null,
    optStatus,
    hasPhone,
    source,
    stage,
    engagement,
    convStatus,
    periodDays: periodDaysInput,
  } = opts;

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = Math.min(parseInt(limit, 10) || 20, 500);
  const skip = (pageNum - 1) * limitNum;
  const query = buildLeadsListQuery(clientId, {
    search,
    tag,
    segmentScore,
    lastSeen,
    importBatchId,
    optStatus,
    hasPhone,
    source,
    stage,
    engagement,
    convStatus,
  });

  const periodDays = Math.min(Math.max(parseInt(periodDaysInput, 10) || 0, 0), 90);
  const periodSince =
    periodDays > 0 ? new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000) : null;

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const activeTodayCond = { $gte: ['$lastInboundAt', dayStart] };
  const activeInPeriodCond = periodSince
    ? {
        $or: [
          { $gte: ['$lastInboundAt', periodSince] },
          { $gte: ['$lastSeen', periodSince] },
        ],
      }
    : activeTodayCond;
  const convInPeriodCond = periodSince
    ? {
        $and: [
          {
            $or: [
              { $and: [{ $ne: ['$chatSummary', null] }, { $ne: ['$chatSummary', ''] }] },
              { $and: [{ $ne: ['$lastMessageContent', null] }, { $ne: ['$lastMessageContent', ''] }] },
            ],
          },
          { $gte: ['$lastSeen', periodSince] },
        ],
      }
    : {
        $or: [
          { $and: [{ $ne: ['$chatSummary', null] }, { $ne: ['$chatSummary', ''] }] },
          { $and: [{ $ne: ['$lastMessageContent', null] }, { $ne: ['$lastMessageContent', ''] }] },
        ],
      };
  const hotInPeriodCond = periodSince
    ? { $and: [{ $gt: ['$linkClicks', 5] }, { $gte: ['$lastSeen', periodSince] }] }
    : { $gt: ['$linkClicks', 5] };

  const [facetOut] = await AdLead.aggregate([
    {
      $facet: {
        page: [
          ...leadsPagePipeline(query, sortBy, skip, limitNum),
        ],
        pageTotal: [{ $match: query }, { $count: 'n' }],
        summary: [
          { $match: { clientId } },
          {
            $group: {
              _id: null,
              activeToday: {
                $sum: {
                  $cond: [activeTodayCond, 1, 0],
                },
              },
              activeInPeriod: {
                $sum: {
                  $cond: [activeInPeriodCond, 1, 0],
                },
              },
              withConversation: {
                $sum: {
                  $cond: [convInPeriodCond, 1, 0],
                },
              },
              highEngagement: {
                $sum: { $cond: [hotInPeriodCond, 1, 0] },
              },
            },
          },
        ],
      },
    },
  ]).allowDiskUse(true);

  const rawPage = facetOut?.page || [];
  const leads = await Promise.all(rawPage.map((row) => enrichLeadRow(clientId, row)));
  const total = facetOut?.pageTotal?.[0]?.n ?? 0;
  const summaryRow = facetOut?.summary?.[0] || {};
  const totalPages = Math.max(1, Math.ceil(total / limitNum));

  return {
    leads,
    currentPage: pageNum,
    totalPages,
    totalLeads: total,
    summary: {
      activeToday: summaryRow.activeToday || 0,
      activeInPeriod: summaryRow.activeInPeriod || summaryRow.activeToday || 0,
      withConversation: summaryRow.withConversation || 0,
      highEngagement: summaryRow.highEngagement || 0,
    },
    pagination: { page: pageNum, limit: limitNum, total, totalPages },
  };
}

/**
 * Materialize Shopify order-only customers into AdLead so segments/campaigns can target them.
 */
async function syncOrderBackedCustomersToAdLeads(clientId) {
  if (!clientId) return { created: 0, updated: 0, skipped: 0 };

  const orderRows = await loadOrderBackedCustomerRows(clientId);
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of orderRows) {
    const phone = phoneForAdLeadStorage(row.phoneNumber);
    if (!phone || isShopifyTestPhone(phone)) {
      skipped += 1;
      continue;
    }

    const suffix = phoneSuffixKey(phone);
    if (!suffix) {
      skipped += 1;
      continue;
    }

    const phoneRegex = new RegExp(`${escapeRegex(suffix)}$`);
    const existing = await AdLead.findOne({ clientId, phoneNumber: phoneRegex }).lean();

    if (existing) {
      const nextOrders = Math.max(Number(existing.ordersCount) || 0, Number(row.ordersCount) || 0);
      const nextSpent = Math.max(Number(existing.totalSpent) || 0, Number(row.totalSpent) || 0);
      const patch = {
        ordersCount: nextOrders,
        totalSpent: nextSpent,
        lifetimeValue: nextSpent,
        isOrderPlaced: true,
      };
      if (row.lastPurchaseDate) {
        patch.lastPurchaseDate = row.lastPurchaseDate;
        patch.lastOrderAt = row.lastOrderAt || row.lastPurchaseDate;
      }
      if (row.email && !existing.email) patch.email = row.email;
      if (row.name && (!existing.name || existing.name === 'Customer')) patch.name = row.name;
      if (!existing.source || existing.source === 'Direct') patch.source = 'shopify';

      const changed =
        nextOrders !== (existing.ordersCount || 0) ||
        nextSpent !== (existing.totalSpent || 0) ||
        patch.email ||
        patch.name;
      if (changed) {
        await AdLead.updateOne({ _id: existing._id, clientId }, { $set: patch });
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    try {
      await AdLead.create({
        clientId,
        phoneNumber: phone,
        name: row.name || 'Customer',
        email: row.email || undefined,
        ordersCount: row.ordersCount || 1,
        totalSpent: row.totalSpent || 0,
        lifetimeValue: row.totalSpent || 0,
        lastPurchaseDate: row.lastPurchaseDate || null,
        lastOrderAt: row.lastOrderAt || row.lastPurchaseDate || null,
        isOrderPlaced: true,
        source: 'shopify',
        optStatus: 'unknown',
        leadScore: Math.min(50, 10 + (Number(row.ordersCount) || 1) * 5),
      });
      created += 1;
    } catch (err) {
      if (err?.code === 11000) skipped += 1;
      else throw err;
    }
  }

  return { created, updated, skipped };
}

module.exports = {
  buildLeadsListQuery,
  fetchLeadsAnalyticsBundle,
  fetchOrderBackedAudienceBundle,
  shouldUseOrderBackedAudience,
  resolveAudienceLeadById,
  syncOrderBackedCustomersToAdLeads,
};
