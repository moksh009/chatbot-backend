'use strict';

const { buildStateMatchOr } = require('./extractStateFromAddress');

/**
 * Mirrors Orders.jsx `orderMatchesListTab` for server-side filtering.
 * @param {object} order - lean order doc
 * @param {string} tab
 */
function orderMatchesListTab(order, tab) {
  const t = String(tab || 'All').toLowerCase();
  const st = String(order?.status || '').toLowerCase();
  const fs = String(order?.financialStatus || '').toLowerCase();
  const ful = String(order?.fulfillmentStatus || '').toLowerCase();
  const cod = !!order?.isCOD;
  if (t === 'all') return true;
  if (t === 'paid') {
    if (cod && (fs === 'pending' || fs === 'authorized' || fs === 'unpaid' || fs === 'partially_paid')) return false;
    return fs === 'paid' || st === 'paid';
  }
  if (t === 'pending') {
    const pendingLike = ['pending', 'authorized', 'partially_paid', 'unpaid'];
    return pendingLike.includes(fs) || st === 'pending' || (cod && fs !== 'paid');
  }
  if (t === 'shipped') return st === 'shipped' || st === 'fulfilled' || ful === 'fulfilled' || ful === 'partial';
  if (t === 'delivered') return st === 'delivered';
  return true;
}

/**
 * Build MongoDB query for order list from HTTP query params.
 * @param {string} clientId
 * @param {Record<string, string|undefined>} query
 */
function buildOrderListQuery(clientId, query = {}) {
  const mongoQuery = { clientId };

  const { phone, productIds, states, startDate, endDate, statusTab, search } = query;

  if (phone) {
    const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
    mongoQuery.$or = [
      { phone: new RegExp(`${cleanPhone}$`) },
      { customerPhone: new RegExp(`${cleanPhone}$`) },
    ];
  }

  if (productIds) {
    const ids = String(productIds)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length) {
      mongoQuery['items.productId'] = { $in: ids };
    }
  }

  const stateClause = buildStateMatchOr(
    states ? String(states).split(',').map((s) => s.trim()).filter(Boolean) : []
  );
  if (stateClause) {
    mongoQuery.$and = mongoQuery.$and || [];
    mongoQuery.$and.push(stateClause);
  }

  if (startDate || endDate) {
    mongoQuery.createdAt = {};
    if (startDate) mongoQuery.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      if (!Number.isNaN(end.getTime())) {
        end.setHours(23, 59, 59, 999);
        mongoQuery.createdAt.$lte = end;
      }
    }
  }

  const q = String(search || '').trim().toLowerCase();
  if (q) {
    const searchRe = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    mongoQuery.$and = mongoQuery.$and || [];
    mongoQuery.$and.push({
      $or: [
        { customerName: searchRe },
        { orderId: searchRe },
        { orderNumber: searchRe },
        { phone: searchRe },
        { customerPhone: searchRe },
        { email: searchRe },
        { customerEmail: searchRe },
        { 'shippingAddress.address1': searchRe },
        { 'shippingAddress.city': searchRe },
        { address: searchRe },
      ],
    });
  }

  return { mongoQuery, statusTab: statusTab || 'All' };
}

/**
 * Apply status tab filter in memory when Mongo cannot express it simply (post-fetch).
 * Prefer calling after dedupe for accuracy matching UI.
 */
function filterOrdersByStatusTab(orders, tab) {
  const t = tab || 'All';
  if (String(t).toLowerCase() === 'all') return orders;
  return orders.filter((o) => orderMatchesListTab(o, t));
}

module.exports = {
  buildOrderListQuery,
  orderMatchesListTab,
  filterOrdersByStatusTab,
};
