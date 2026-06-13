'use strict';

const { withShopifyRetry } = require('./shopifyHelper');
const { enrichShopifyCustomers } = require('./shopifyCustomerEnrichment');
const {
  loadWarrantySignalsByIdentity,
  appendWorkspaceCustomers,
} = require('./shopifyCustomerWorkspaceSignals');
const { normalizePhone } = require('../core/helpers');
const {
  phoneSuffixKey: _phoneSuffixKey,
  normalizeEmailKey: _normalizeEmailKey,
  namesAreSimilar: _namesAreSimilar,
  customerDisplayName: _customerDisplayName,
  dedupeOrdersByNumber: _dedupeOrdersByNumber,
  assignOrdersToCustomers,
  applyAssignmentMetrics,
  ordersForCustomerFromAssignment,
  profilesLinkedByOrderEvidence,
} = require('./customerOrderAttribution');

async function loadClientOrdersForCustomerMetrics(clientId) {
  const Order = require('../../models/Order');
  return Order.find({ clientId })
    .select(
      'orderId orderNumber shopifyOrderId shopifyCustomerId phone customerPhone email customerEmail totalPrice amount status financialStatus fulfillmentStatus customerName shippingAddress createdAt'
    )
    .sort({ createdAt: -1 })
    .limit(15000)
    .lean();
}

function prepareCustomerList(source) {
  return mergeShopifyCustomersByIdentity(source || []);
}

async function hydrateCustomerSource(clientId, cacheSource = []) {
  const Client = require('../../models/Client');
  const client = await Client.findOne({ clientId }).select('enableWarranty').lean();
  const warrantyEnabled = Boolean(client?.enableWarranty);
  const emptyMaps = { byContactId: new Map(), byPhone: new Map(), byEmail: new Map() };
  const warrantyMaps = warrantyEnabled
    ? await loadWarrantySignalsByIdentity(clientId)
    : emptyMaps;
  const enriched = await enrichShopifyCustomers(clientId, cacheSource, warrantyMaps);
  return appendWorkspaceCustomers(enriched, warrantyMaps);
}

async function buildCustomerOrderAssignment(clientId, customers) {
  const rawOrders = await loadClientOrdersForCustomerMetrics(clientId);
  let merged = mergeShopifyCustomersByIdentity(customers);
  let { assignment } = assignOrdersToCustomers(merged, rawOrders);

  const postMerged = mergeCustomersByOrderEvidence(merged, assignment);
  if (postMerged.length < merged.length) {
    merged = postMerged;
    ({ assignment } = assignOrdersToCustomers(merged, rawOrders));
  }

  return { customers: merged, assignment, rawOrders };
}

async function attachOrderMetrics(clientId, customers) {
  if (!customers.length) return customers;
  const { customers: merged, assignment } = await buildCustomerOrderAssignment(clientId, customers);
  return applyAssignmentMetrics(merged, assignment);
}

function phoneMatchQuery(phone) {
  const norm = normalizePhone(phone);
  const digits = String(phone || '').replace(/\D/g, '');
  const suffix = digits.length >= 10 ? digits.slice(-10) : digits;
  const or = [{ phone: norm }, { customerPhone: norm }];
  if (suffix) {
    or.push({ phone: { $regex: `${suffix}$` } }, { customerPhone: { $regex: `${suffix}$` } });
  }
  if (phone && phone !== norm) {
    or.push({ phone }, { customerPhone: phone });
  }
  return { $or: or };
}

const MAX_SYNC_CUSTOMERS = 500;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;

const TIER_THRESHOLDS = {
  vip: 10000,
  regular: 5000,
};

function getSpendTier(totalSpent) {
  const spent = parseFloat(totalSpent || 0);
  if (spent >= TIER_THRESHOLDS.vip) return 'vip';
  if (spent >= TIER_THRESHOLDS.regular) return 'regular';
  return 'new';
}

function parseLinkNextPageInfo(linkHeader) {
  if (!linkHeader || typeof linkHeader !== 'string') return null;
  const match = linkHeader.match(/page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function fetchShopifyCustomersBatch(shop, { max = MAX_SYNC_CUSTOMERS } = {}) {
  const all = [];
  let pageInfo = null;

  while (all.length < max) {
    const limit = Math.min(250, max - all.length);
    const params = { limit };
    if (pageInfo) {
      params.page_info = pageInfo;
    } else {
      params.order = 'total_spent desc';
    }

    const response = await shop.get('/customers.json', { params });
    const batch = response.data?.customers || [];
    all.push(...batch);

    if (batch.length < limit) break;
    pageInfo = parseLinkNextPageInfo(response.headers?.link || response.headers?.Link);
    if (!pageInfo) break;
  }

  return all.slice(0, max);
}

function sortCustomers(list, sortBy) {
  const arr = [...list];
  const num = (v) => Number(v) || 0;

  switch (sortBy) {
    case 'orders':
      arr.sort((a, b) => num(b.orders_count) - num(a.orders_count));
      break;
    case 'last_order':
      arr.sort(
        (a, b) =>
          new Date(b.updated_at || b.created_at || 0).getTime() -
          new Date(a.updated_at || a.created_at || 0).getTime()
      );
      break;
    case 'lead_score':
      arr.sort((a, b) => {
        const as = a.leadScore == null ? -1 : num(a.leadScore);
        const bs = b.leadScore == null ? -1 : num(b.leadScore);
        return bs - as;
      });
      break;
    case 'spend':
    default:
      arr.sort((a, b) => num(b.total_spent) - num(a.total_spent));
      break;
  }
  return arr;
}

function filterCustomers(list, { tier, topedge, search }) {
  let out = list;

  if (tier && tier !== 'all') {
    out = out.filter((c) => getSpendTier(c.total_spent) === tier);
  }

  if (topedge && topedge !== 'all') {
    if (topedge === 'has_score') {
      out = out.filter((c) => c.leadScore != null && Number(c.leadScore) > 0);
    } else if (topedge === 'has_warranty') {
      out = out.filter((c) => Number(c.warrantyTotal || 0) > 0);
    }
  }

  const q = String(search || '').trim().toLowerCase();
  if (q) {
    out = out.filter((c) => {
      const name = `${c.first_name || ''} ${c.last_name || ''} ${c.leadName || ''}`.toLowerCase();
      const email = String(c.email || '').toLowerCase();
      const phone = String(c.phone || c.workspacePhone || '').toLowerCase();
      return name.includes(q) || email.includes(q) || phone.includes(q);
    });
  }

  return out;
}

function summarizeCustomers(list, whatsappChatPhones = null) {
  let totalLtv = 0;
  let whatsappLinked = 0;
  let withLeadScore = 0;
  let vipCount = 0;
  const chatPhones = whatsappChatPhones instanceof Set ? whatsappChatPhones : null;
  for (const c of list) {
    totalLtv += Number(c.total_spent) || 0;
    if (c.workspacePhone && chatPhones) {
      const p = normalizePhone(c.workspacePhone);
      if (p && chatPhones.has(p)) whatsappLinked += 1;
    }
    if (c.leadScore != null && Number(c.leadScore) > 0) withLeadScore += 1;
    if (getSpendTier(c.total_spent) === 'vip') vipCount += 1;
  }
  return {
    total: list.length,
    totalLtv: Math.round(totalLtv),
    whatsappLinked,
    withLeadScore,
    vipCount,
  };
}

async function loadWhatsAppChatPhoneSet(clientId) {
  const Conversation = require('../../models/Conversation');
  const docs = await Conversation.find({ clientId }).select('phone').lean();
  const set = new Set();
  for (const doc of docs || []) {
    const p = normalizePhone(doc.phone);
    if (p) set.add(p);
  }
  return set;
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const o = parseInt(parsed?.o, 10);
    return Number.isFinite(o) && o >= 0 ? o : 0;
  } catch {
    return 0;
  }
}

function paginateCustomers(list, { cursor, limit }) {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit, 10) || DEFAULT_PAGE_SIZE));
  const offset = decodeCursor(cursor);
  const slice = list.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  const hasMore = nextOffset < list.length;

  return {
    customers: slice,
    pageSize,
    offset,
    total: list.length,
    hasMore,
    nextCursor: hasMore ? encodeCursor(nextOffset) : null,
  };
}

async function syncShopifyCustomersForClient(clientId) {
  const Client = require('../../models/Client');

  const raw = await withShopifyRetry(clientId, async (shop) => fetchShopifyCustomersBatch(shop));
  const enriched = await enrichShopifyCustomers(clientId, raw || []);
  const syncedAt = new Date();

  await Client.updateOne(
    { clientId },
    {
      $set: {
        customersSyncedAt: syncedAt,
        shopifyCustomersCache: enriched,
        shopifyCustomersCacheCount: enriched.length,
      },
    }
  );

  return { customers: enriched, syncedAt, count: enriched.length };
}

async function listShopifyCustomersForClient(clientId, query = {}) {
  const Client = require('../../models/Client');
  const client = await Client.findOne({ clientId })
    .select('customersSyncedAt shopifyCustomersCache shopifyCustomersCacheCount')
    .lean();

  let source = client?.shopifyCustomersCache || [];
  const cacheWasEmpty = source.length === 0;
  let syncError = null;

  if (cacheWasEmpty) {
    try {
      const synced = await syncShopifyCustomersForClient(clientId);
      source = synced.customers;
    } catch (err) {
      syncError = err.message;
      source = [];
    }
  }

  source = await hydrateCustomerSource(clientId, source);

  if (!source.length && cacheWasEmpty && syncError) {
    return {
      customers: [],
      total: 0,
      hasMore: false,
      nextCursor: null,
      needsSync: true,
      syncedAt: null,
      error: syncError,
    };
  }

  const sorted = sortCustomers(
    await attachOrderMetrics(clientId, prepareCustomerList(source)),
    query.sort || 'spend'
  );
  const filtered = filterCustomers(sorted, query);
  const page = paginateCustomers(filtered, {
    cursor: query.cursor,
    limit: query.limit,
  });
  const whatsappChatPhones = await loadWhatsAppChatPhoneSet(clientId);

  return {
    ...page,
    summary: summarizeCustomers(filtered, whatsappChatPhones),
    syncedAt: client?.customersSyncedAt || null,
    cacheCount: client?.shopifyCustomersCacheCount ?? source.length,
    needsSync: cacheWasEmpty && source.length === 0,
  };
}

function formatAddressLine(order) {
  const sa = order.shippingAddress;
  if (sa && typeof sa === 'object') {
    const parts = [
      sa.address1 || sa.line1,
      sa.address2 || sa.line2,
      sa.city,
      sa.province || sa.state,
      sa.zip || sa.postal_code,
      sa.country,
    ].filter(Boolean);
    if (parts.length) return parts.join(', ');
  }
  const parts = [order.address, order.city, order.state, order.zip].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

async function getShopifyCustomerDetail(clientId, customerId) {
  const Client = require('../../models/Client');

  const client = await Client.findOne({ clientId })
    .select('shopifyCustomersCache customersSyncedAt')
    .lean();
  if (!client) return null;

  const source = await hydrateCustomerSource(clientId, client.shopifyCustomersCache || []);
  const { customers: merged, assignment } = await buildCustomerOrderAssignment(clientId, source);
  const customer = findMergedCustomer(merged, customerId);
  if (!customer) return null;

  const { orders, orders_count, total_spent } = ordersForCustomerFromAssignment(customer.id, assignment);

  return {
    customer: {
      ...customer,
      orders_count,
      total_spent: String(total_spent),
    },
    syncedAt: client.customersSyncedAt || null,
    orders: orders.map((o) => ({
      ...o,
      formattedAddress: formatAddressLine(o),
      lineItems: (o.items || []).map((it) => ({
        name: it.name,
        quantity: it.quantity,
        price: it.price,
        sku: it.sku,
        image: it.image,
      })),
    })),
  };
}

// --- Customer identity merge + order metrics (inlined) ---

function _uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const v of list || []) {
    const s = String(v || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function _normalizeOrderNumberKey(order) {
  const raw = String(order?.orderNumber || order?.orderId || '').replace(/^#+/g, '').trim();
  return raw || null;
}

function _collectEmailKeys(customer) {
  const keys = new Set();
  const emails = _uniqueStrings([customer.email, ...(customer.linkedEmails || [])]);
  for (const em of emails) {
    const ek = _normalizeEmailKey(em);
    if (ek) keys.add(`email:${ek}`);
  }
  return keys;
}

function _collectPhoneKeys(customer) {
  const keys = new Set();
  const phones = _uniqueStrings([customer.phone, customer.workspacePhone, ...(customer.linkedPhones || [])]);
  for (const ph of phones) {
    const ps = _phoneSuffixKey(ph);
    if (ps) keys.add(`phone:${ps}`);
  }
  return keys;
}

function _mergeCustomerGroup(group) {
  if (!group.length) return null;
  if (group.length === 1) {
    const one = group[0];
    return {
      ...one,
      linkedPhones: _uniqueStrings([one.phone, one.workspacePhone, ...(one.linkedPhones || [])]),
      linkedEmails: _uniqueStrings([one.email, ...(one.linkedEmails || [])]),
      mergedCustomerIds: [String(one.id)],
    };
  }
  const bySpend = [...group].sort((a, b) => Number(b.total_spent) - Number(a.total_spent));
  let bestName = bySpend[0];
  for (const c of group) {
    const len = `${c.first_name || ''} ${c.last_name || ''}`.trim().length;
    const bestLen = `${bestName.first_name || ''} ${bestName.last_name || ''}`.trim().length;
    if (len > bestLen) bestName = c;
  }
  const linkedPhones = new Set();
  const linkedEmails = new Set();
  const mergedCustomerIds = [];
  let leadScore = null;
  let scoreStageName = null;
  let leadId = null;
  let leadName = null;
  let workspacePhone = null;
  const tags = new Set();
  for (const c of group) {
    mergedCustomerIds.push(String(c.id));
    for (const ph of [c.phone, c.workspacePhone, ...(c.linkedPhones || [])]) {
      if (ph) linkedPhones.add(String(ph).trim());
    }
    const em = _normalizeEmailKey(c.email);
    if (em) linkedEmails.add(em);
    for (const em2 of c.linkedEmails || []) {
      const ek = _normalizeEmailKey(em2);
      if (ek) linkedEmails.add(ek);
    }
    if (c.workspacePhone && !workspacePhone) workspacePhone = c.workspacePhone;
    if (c.leadScore != null && (leadScore == null || Number(c.leadScore) > leadScore)) {
      leadScore = c.leadScore;
      scoreStageName = c.scoreStageName;
      leadId = c.leadId;
      leadName = c.leadName;
    }
    for (const t of c.tags || []) {
      if (t) tags.add(String(t));
    }
  }
  const primary = bySpend[0];
  const displayPhone = workspacePhone || primary.phone || [...linkedPhones][0] || null;
  return {
    ...primary,
    id: String(primary.id),
    first_name: bestName.first_name,
    last_name: bestName.last_name,
    phone: displayPhone,
    workspacePhone: workspacePhone || displayPhone,
    linkedPhones: [...linkedPhones],
    linkedEmails: [...linkedEmails],
    mergedCustomerIds,
    leadScore,
    scoreStageName,
    leadId,
    leadName,
    tags: [...tags],
    _mergedFrom: group.length,
  };
}

function mergeShopifyCustomersByIdentity(customers) {
  if (!Array.isArray(customers) || customers.length <= 1) {
    return (customers || []).map((c) => _mergeCustomerGroup([c])).filter(Boolean);
  }
  const n = customers.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]];
      r = parent[r];
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const emailKeyToIdx = new Map();
  customers.forEach((c, i) => {
    for (const k of _collectEmailKeys(c)) {
      if (emailKeyToIdx.has(k)) union(i, emailKeyToIdx.get(k));
      else emailKeyToIdx.set(k, i);
    }
  });

  const phoneKeyToIndices = new Map();
  customers.forEach((c, i) => {
    for (const k of _collectPhoneKeys(c)) {
      if (!phoneKeyToIndices.has(k)) phoneKeyToIndices.set(k, []);
      phoneKeyToIndices.get(k).push(i);
    }
  });
  for (const indices of phoneKeyToIndices.values()) {
    for (let a = 0; a < indices.length; a += 1) {
      for (let b = a + 1; b < indices.length; b += 1) {
        const i = indices[a];
        const j = indices[b];
        if (_namesAreSimilar(_customerDisplayName(customers[i]), _customerDisplayName(customers[j]))) {
          union(i, j);
        }
      }
    }
  }

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const lastA = String(customers[i].last_name || '').trim().toLowerCase();
      const lastB = String(customers[j].last_name || '').trim().toLowerCase();
      if (
        lastA.length >= 2 &&
        lastA === lastB &&
        _namesAreSimilar(_customerDisplayName(customers[i]), _customerDisplayName(customers[j]))
      ) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  customers.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });
  return Array.from(groups.values()).map(_mergeCustomerGroup).filter(Boolean);
}

function mergeCustomersByOrderEvidence(customers, assignment) {
  if (!Array.isArray(customers) || customers.length <= 1) {
    return customers;
  }
  const n = customers.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]];
      r = parent[r];
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (profilesLinkedByOrderEvidence(customers[i], customers[j], assignment)) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  customers.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });
  return Array.from(groups.values()).map(_mergeCustomerGroup).filter(Boolean);
}

function findMergedCustomer(customers, customerId) {
  const idStr = String(customerId);
  return (
    customers.find(
      (c) =>
        String(c.id) === idStr ||
        (Array.isArray(c.mergedCustomerIds) && c.mergedCustomerIds.includes(idStr))
    ) || null
  );
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_SYNC_CUSTOMERS,
  getSpendTier,
  syncShopifyCustomersForClient,
  listShopifyCustomersForClient,
  getShopifyCustomerDetail,
  sortCustomers,
  filterCustomers,
  paginateCustomers,
  mergeShopifyCustomersByIdentity,
  mergeCustomersByOrderEvidence,
  buildCustomerOrderAssignment,
};
