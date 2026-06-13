'use strict';

const PLACEHOLDER_PHONE_SUFFIX = '0000000000';

const SCORE = {
  SHOPIFY_CUSTOMER_ID: 100,
  EMAIL: 80,
  PHONE_NAME: 60,
  PHONE_ONLY: 30,
};

function phoneSuffixKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const suffix = d.length >= 10 ? d.slice(-10) : '';
  if (!suffix || suffix === PLACEHOLDER_PHONE_SUFFIX) return '';
  return suffix;
}

function normalizeEmailKey(email) {
  const e = String(email || '').trim().toLowerCase();
  return e && e.includes('@') ? e : '';
}

function normalizePersonName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

function namesAreSimilar(a, b) {
  const ta = normalizePersonName(a);
  const tb = normalizePersonName(b);
  if (!ta.length || !tb.length) return false;

  const firstA = ta[0] || '';
  const firstB = tb[0] || '';
  if (firstA && firstB) {
    if (firstA === firstB) return true;
    if (
      firstA.length >= 3 &&
      firstB.length >= 3 &&
      (firstA.includes(firstB) || firstB.includes(firstA))
    ) {
      return true;
    }
    if (
      firstA.length >= 3 &&
      firstB.length >= 3 &&
      firstA.slice(0, 3) === firstB.slice(0, 3)
    ) {
      return true;
    }
    const maxLen = Math.max(firstA.length, firstB.length);
    if (
      maxLen <= 6 &&
      levenshtein(firstA, firstB) <= 3 &&
      firstA.slice(0, 2) === firstB.slice(0, 2)
    ) {
      return true;
    }
  }

  if (ta.length === 1 && tb.length === 1) {
    const t = ta[0];
    const u = tb[0];
    return (
      t === u ||
      (t.length >= 3 && u.length >= 3 && (t.includes(u) || u.includes(t)))
    );
  }

  return false;
}

function customerDisplayName(customer) {
  const shopify = `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim();
  return shopify || customer?.leadName || '';
}

function customerShopifyIds(customer) {
  const ids = new Set();
  if (customer?.id != null) ids.add(String(customer.id));
  for (const mid of customer?.mergedCustomerIds || []) {
    if (mid != null) ids.add(String(mid));
  }
  return ids;
}

function collectCustomerEmails(customer) {
  const keys = new Set();
  const em = normalizeEmailKey(customer?.email);
  if (em) keys.add(em);
  for (const e of customer?.linkedEmails || []) {
    const ek = normalizeEmailKey(e);
    if (ek) keys.add(ek);
  }
  return keys;
}

function collectCustomerPhones(customer) {
  const keys = new Set();
  for (const ph of [customer?.phone, customer?.workspacePhone, ...(customer?.linkedPhones || [])]) {
    const ps = phoneSuffixKey(ph);
    if (ps) keys.add(ps);
  }
  return keys;
}

function normalizeOrderNumberKey(order) {
  const raw = String(order?.orderNumber || order?.orderId || '').replace(/^#+/g, '').trim();
  return raw || null;
}

function orderRichnessScore(doc) {
  let s = 0;
  const ship = doc.shippingAddress;
  if (ship && (ship.address1 || ship.city || ship.province || ship.province_code)) s += 5;
  if (doc.customerName && String(doc.customerName).trim().length > 3) s += 3;
  if (doc.customerPhone || doc.phone) s += 2;
  if (doc.financialStatus) s += 2;
  if (doc.fulfillmentStatus && doc.fulfillmentStatus !== 'unfulfilled') s += 2;
  if (doc.shopifyCustomerId) s += 2;
  if (doc.isCOD) s += 1;
  if (doc.shopifyOrderId) s += 1;
  return s;
}

function dedupeOrdersByNumber(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return orders;
  const byKey = new Map();
  for (const o of orders) {
    const num = normalizeOrderNumberKey(o);
    const k = num ? `n:${num}` : o.shopifyOrderId ? `sid:${String(o.shopifyOrderId)}` : `id:${String(o._id)}`;
    const prev = byKey.get(k);
    if (!prev || orderRichnessScore(o) >= orderRichnessScore(prev)) byKey.set(k, o);
  }
  return [...byKey.values()].sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
}

function scoreOrderForCustomer(order, customer) {
  const orderCustId = String(order.shopifyCustomerId || '').trim();
  const custIds = customerShopifyIds(customer);
  if (orderCustId && custIds.has(orderCustId)) return SCORE.SHOPIFY_CUSTOMER_ID;

  const orderEmail = normalizeEmailKey(order.customerEmail || order.email);
  const custEmails = collectCustomerEmails(customer);
  if (orderEmail && custEmails.has(orderEmail)) return SCORE.EMAIL;

  const orderPhone = phoneSuffixKey(order.customerPhone || order.phone);
  const custPhones = collectCustomerPhones(customer);
  if (orderPhone && custPhones.has(orderPhone)) {
    const orderName = order.customerName || '';
    const custName = customerDisplayName(customer);
    if (namesAreSimilar(orderName, custName)) return SCORE.PHONE_NAME;
    return SCORE.PHONE_ONLY;
  }

  return 0;
}

/**
 * Assign each order to exactly one customer profile (highest score wins).
 * @returns {{ assignment: Map<string, object[]>, deduped: object[], unassigned: object[] }}
 */
function assignOrdersToCustomers(customers, rawOrders) {
  const deduped = dedupeOrdersByNumber(rawOrders);
  const assignment = new Map();
  for (const c of customers) {
    assignment.set(String(c.id), []);
  }
  const unassigned = [];

  for (const order of deduped) {
    let best = null;
    let bestScore = 0;
    let bestSpend = -1;

    for (const c of customers) {
      const score = scoreOrderForCustomer(order, c);
      const spend = Number(c.total_spent) || 0;
      if (
        score > bestScore ||
        (score === bestScore && score > 0 && spend > bestSpend)
      ) {
        bestScore = score;
        best = c;
        bestSpend = spend;
      }
    }

    if (!best || bestScore < SCORE.PHONE_ONLY) {
      unassigned.push(order);
      continue;
    }

    if (bestScore === SCORE.PHONE_ONLY) {
      const custName = customerDisplayName(best);
      if (!namesAreSimilar(order.customerName, custName)) {
        unassigned.push(order);
        continue;
      }
    }

    assignment.get(String(best.id)).push(order);
  }

  return { assignment, deduped, unassigned };
}

function ordersForCustomerFromAssignment(customerId, assignment) {
  const orders = assignment.get(String(customerId)) || [];
  const totalSpent = orders.reduce((sum, o) => sum + (Number(o.totalPrice ?? o.amount) || 0), 0);
  return {
    orders: [...orders].sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    ),
    orders_count: orders.length,
    total_spent: Math.round(totalSpent),
  };
}

function applyAssignmentMetrics(customers, assignment) {
  return customers.map((c) => {
    const metrics = ordersForCustomerFromAssignment(c.id, assignment);
    return {
      ...c,
      orders_count: metrics.orders_count,
      total_spent: String(metrics.total_spent),
      orderMetricsSource: 'workspace_orders',
    };
  });
}

/**
 * Merge profiles when assigned orders share email and display names are similar (Nakshu phone+email split).
 */
function profilesLinkedByOrderEvidence(customerA, customerB, assignment) {
  if (!namesAreSimilar(customerDisplayName(customerA), customerDisplayName(customerB))) {
    return false;
  }

  const ordersA = assignment.get(String(customerA.id)) || [];
  const ordersB = assignment.get(String(customerB.id)) || [];
  const emailsOnOrders = new Set();
  for (const o of [...ordersA, ...ordersB]) {
    const e = normalizeEmailKey(o.customerEmail || o.email);
    if (e) emailsOnOrders.add(e);
  }
  if (emailsOnOrders.size === 0) return false;

  const profileEmails = new Set([
    ...collectCustomerEmails(customerA),
    ...collectCustomerEmails(customerB),
  ]);

  for (const e of emailsOnOrders) {
    if (profileEmails.has(e)) return true;
    const aHas = ordersA.some((o) => normalizeEmailKey(o.customerEmail || o.email) === e);
    const bHas = ordersB.some((o) => normalizeEmailKey(o.customerEmail || o.email) === e);
    if (aHas && bHas) return true;
  }
  return false;
}

module.exports = {
  SCORE,
  PLACEHOLDER_PHONE_SUFFIX,
  phoneSuffixKey,
  normalizeEmailKey,
  normalizePersonName,
  namesAreSimilar,
  customerDisplayName,
  customerShopifyIds,
  collectCustomerEmails,
  collectCustomerPhones,
  dedupeOrdersByNumber,
  scoreOrderForCustomer,
  assignOrdersToCustomers,
  ordersForCustomerFromAssignment,
  applyAssignmentMetrics,
  profilesLinkedByOrderEvidence,
};
