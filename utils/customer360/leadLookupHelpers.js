'use strict';

const Contact = require('../../models/Contact');
const Order = require('../../models/Order');
const WarrantyRecord = require('../../models/WarrantyRecord');
const AdLead = require('../../models/AdLead');
const { phoneVariants } = require('../messaging/cancelAllAutomationsFor');

function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e && e.includes('@') ? e : '';
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildEmailRegex(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return new RegExp(`^${escapeRegex(normalized)}$`, 'i');
}

function collectPhoneVariants(phones = []) {
  const variants = new Set();
  for (const phone of phones) {
    for (const v of phoneVariants(phone)) {
      if (v) variants.add(v);
    }
  }
  return [...variants];
}

function buildOrderPhoneQuery(clientId, phoneNumber) {
  const variants = phoneVariants(phoneNumber);
  if (!variants.length) {
    return { clientId, _id: null };
  }
  return {
    clientId,
    $or: [
      { phone: { $in: variants } },
      { customerPhone: { $in: variants } },
    ],
  };
}

function buildOrderIdentityQuery(clientId, { phoneNumber, email, extraPhones = [] } = {}) {
  const orClauses = [];
  const phoneList = collectPhoneVariants([phoneNumber, ...extraPhones]);

  if (phoneList.length) {
    orClauses.push({ phone: { $in: phoneList } });
    orClauses.push({ customerPhone: { $in: phoneList } });
  }

  const emailRegex = buildEmailRegex(email);
  if (emailRegex) {
    orClauses.push({ customerEmail: emailRegex });
    orClauses.push({ email: emailRegex });
  }

  if (!orClauses.length) {
    return { clientId, _id: null };
  }

  return { clientId, $or: orClauses };
}

function dedupeOrders(orders = []) {
  const seen = new Set();
  const merged = [];

  for (const order of orders) {
    const key = String(order?.shopifyOrderId || order?.orderId || order?._id || '').trim();
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    merged.push(order);
  }

  return merged.sort(
    (a, b) => new Date(b.createdAt || b.orderDate || 0) - new Date(a.createdAt || a.orderDate || 0)
  );
}

function orderAmount(order) {
  const value = parseFloat(order?.totalPrice ?? order?.amount ?? order?.total ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function summarizeOrders(orders = []) {
  const deduped = dedupeOrders(orders);
  const totalSpent = deduped.reduce((sum, order) => sum + orderAmount(order), 0);
  const lastPurchaseDate = deduped[0]?.createdAt || deduped[0]?.orderDate || null;
  return {
    orders: deduped,
    ordersCount: deduped.length,
    totalSpent,
    lastPurchaseDate,
  };
}

async function resolveLinkedPhonesForLead(clientId, phoneNumber, email) {
  const linked = new Set();
  if (phoneNumber) linked.add(String(phoneNumber).trim());

  const emailRegex = buildEmailRegex(email);
  if (!emailRegex) {
    return [...linked].filter(Boolean);
  }

  const [siblingLeads, emailOrders] = await Promise.all([
    AdLead.find({
      clientId,
      email: emailRegex,
      phoneNumber: { $exists: true, $nin: ['', null] },
    })
      .select('phoneNumber')
      .limit(30)
      .lean(),
    Order.find({
      clientId,
      $or: [{ customerEmail: emailRegex }, { email: emailRegex }],
    })
      .select('phone customerPhone')
      .limit(80)
      .lean(),
  ]);

  for (const lead of siblingLeads) {
    if (lead?.phoneNumber) linked.add(String(lead.phoneNumber).trim());
  }
  for (const order of emailOrders) {
    if (order?.customerPhone) linked.add(String(order.customerPhone).trim());
    if (order?.phone) linked.add(String(order.phone).trim());
  }

  return [...linked].filter(Boolean);
}

async function findContactForPhone(clientId, phoneNumber) {
  const variants = phoneVariants(phoneNumber);
  if (!variants.length) return null;
  return Contact.findOne({ clientId, phoneNumber: { $in: variants } }).lean();
}

async function findOrdersForLead(clientId, phoneNumber, { email, limit = 20, extraPhones = [] } = {}) {
  const linkedPhones = await resolveLinkedPhonesForLead(clientId, phoneNumber, email);
  const identityPhones = [...new Set([...linkedPhones, ...extraPhones])];
  const query = buildOrderIdentityQuery(clientId, {
    phoneNumber,
    email,
    extraPhones: identityPhones,
  });

  const orders = await Order.find(query)
    .sort({ createdAt: -1 })
    .limit(Math.max(limit, 50))
    .lean();

  return dedupeOrders(orders).slice(0, limit);
}

function mapEmbeddedWarrantyRecords(lead) {
  return (lead?.warrantyRecords || []).map((r, i) => ({
    _id: r.serialNumber || r.orderId || `embedded_${i}`,
    productName: r.productName,
    sku: r.serialNumber,
    status: r.status || 'active',
    expiryDate: r.expiryDate,
    purchaseDate: r.purchaseDate,
    shopifyOrderId: r.orderId,
    source: 'lead_profile',
  }));
}

async function findWarrantyRecordsForLead(clientId, phoneNumber, lead = null) {
  const embedded = mapEmbeddedWarrantyRecords(lead);
  const contact = await findContactForPhone(clientId, phoneNumber);
  const dbRecords = contact
    ? await WarrantyRecord.find({ clientId, customerId: contact._id })
        .sort({ purchaseDate: -1 })
        .limit(20)
        .lean()
    : [];

  const seen = new Set();
  const merged = [];
  for (const rec of [...dbRecords, ...embedded]) {
    const key = `${rec.shopifyOrderId || ''}:${rec.productId || rec.productName || rec._id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rec);
  }
  return { records: merged, contact };
}

module.exports = {
  normalizeEmail,
  buildOrderPhoneQuery,
  buildOrderIdentityQuery,
  dedupeOrders,
  summarizeOrders,
  resolveLinkedPhonesForLead,
  findContactForPhone,
  findOrdersForLead,
  findWarrantyRecordsForLead,
  mapEmbeddedWarrantyRecords,
};
