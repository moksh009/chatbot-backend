'use strict';

const { dedupeOrdersByShopifyKey, normalizeOrderNumberKey } = require('./orderDedupe');

function phoneSuffixKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

function normalizeEmailKey(email) {
  const e = String(email || '').trim().toLowerCase();
  return e && e.includes('@') ? e : '';
}

function uniqueStrings(list) {
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

function collectIdentityKeys(customer) {
  const keys = new Set();
  const phones = uniqueStrings([
    customer.phone,
    customer.workspacePhone,
    ...(customer.linkedPhones || []),
  ]);
  for (const ph of phones) {
    const ps = phoneSuffixKey(ph);
    if (ps) keys.add(`phone:${ps}`);
  }
  const emails = uniqueStrings([customer.email, ...(customer.linkedEmails || [])]);
  for (const em of emails) {
    const ek = normalizeEmailKey(em);
    if (ek) keys.add(`email:${ek}`);
  }
  return keys;
}

function mergeCustomerGroup(group) {
  if (!group.length) return null;
  if (group.length === 1) {
    const one = group[0];
    return {
      ...one,
      linkedPhones: uniqueStrings([one.phone, one.workspacePhone, ...(one.linkedPhones || [])]),
      linkedEmails: uniqueStrings([one.email, ...(one.linkedEmails || [])]),
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
    const em = normalizeEmailKey(c.email);
    if (em) linkedEmails.add(em);
    for (const em2 of c.linkedEmails || []) {
      const ek = normalizeEmailKey(em2);
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

/**
 * Union-find merge: same last-10 phone OR same email → one customer row.
 */
function mergeShopifyCustomersByIdentity(customers) {
  if (!Array.isArray(customers) || customers.length <= 1) {
    return (customers || []).map((c) => mergeCustomerGroup([c])).filter(Boolean);
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

  const keyToIdx = new Map();
  customers.forEach((c, i) => {
    for (const k of collectIdentityKeys(c)) {
      if (keyToIdx.has(k)) union(i, keyToIdx.get(k));
      else keyToIdx.set(k, i);
    }
  });

  const groups = new Map();
  customers.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });

  return Array.from(groups.values())
    .map(mergeCustomerGroup)
    .filter(Boolean);
}

function orderMatchesCustomer(order, customer) {
  const phoneKeys = new Set();
  const emailKeys = new Set();

  for (const ph of [
    customer.phone,
    customer.workspacePhone,
    ...(customer.linkedPhones || []),
  ]) {
    const ps = phoneSuffixKey(ph);
    if (ps) phoneKeys.add(ps);
  }
  for (const em of [customer.email, ...(customer.linkedEmails || [])]) {
    const ek = normalizeEmailKey(em);
    if (ek) emailKeys.add(ek);
  }

  const orderPhones = [order.phone, order.customerPhone];
  for (const ph of orderPhones) {
    const ps = phoneSuffixKey(ph);
    if (ps && phoneKeys.has(ps)) return true;
  }
  for (const em of [order.email, order.customerEmail]) {
    const ek = normalizeEmailKey(em);
    if (ek && emailKeys.has(ek)) return true;
  }
  return false;
}

function buildCustomerOrderIndex(orders) {
  const deduped = dedupeOrdersByShopifyKey(orders);
  const byKey = new Map();
  for (const o of deduped) {
    const k = normalizeOrderNumberKey(o) || String(o._id);
    byKey.set(k, o);
  }
  return { deduped, byKey };
}

function ordersForCustomer(customer, orderIndex) {
  const { deduped, byKey } = orderIndex;
  const matchedKeys = new Set();
  for (const o of deduped) {
    if (!orderMatchesCustomer(o, customer)) continue;
    matchedKeys.add(normalizeOrderNumberKey(o) || String(o._id));
  }
  const orders = [...matchedKeys]
    .map((k) => byKey.get(k))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const totalSpent = orders.reduce(
    (sum, o) => sum + (Number(o.totalPrice ?? o.amount) || 0),
    0
  );

  return {
    orders,
    orders_count: orders.length,
    total_spent: Math.round(totalSpent),
  };
}

function applyOrderMetricsToCustomers(customers, orderIndex) {
  return customers.map((c) => {
    const metrics = ordersForCustomer(c, orderIndex);
    return {
      ...c,
      orders_count: metrics.orders_count,
      total_spent: String(metrics.total_spent),
      orderMetricsSource: 'workspace_orders',
    };
  });
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
  phoneSuffixKey,
  normalizeEmailKey,
  mergeShopifyCustomersByIdentity,
  buildCustomerOrderIndex,
  ordersForCustomer,
  applyOrderMetricsToCustomers,
  findMergedCustomer,
  orderMatchesCustomer,
};
