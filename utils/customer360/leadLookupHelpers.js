'use strict';

const Contact = require('../../models/Contact');
const Order = require('../../models/Order');
const WarrantyRecord = require('../../models/WarrantyRecord');
const { phoneVariants } = require('../messaging/cancelAllAutomationsFor');

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

async function findContactForPhone(clientId, phoneNumber) {
  const variants = phoneVariants(phoneNumber);
  if (!variants.length) return null;
  return Contact.findOne({ clientId, phoneNumber: { $in: variants } }).lean();
}

async function findOrdersForLead(clientId, phoneNumber, { limit = 20 } = {}) {
  return Order.find(buildOrderPhoneQuery(clientId, phoneNumber))
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
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
  buildOrderPhoneQuery,
  findContactForPhone,
  findOrdersForLead,
  findWarrantyRecordsForLead,
  mapEmbeddedWarrantyRecords,
};
