'use strict';

const Order = require('../models/Order');

/**
 * Append a WhatsApp dispatch record on an order (capped at 50 entries).
 * @param {string|import('mongoose').Types.ObjectId} orderId
 * @param {object} entry
 */
async function appendOrderWhatsAppActivity(orderId, entry) {
  if (!orderId) return;
  const row = {
    at: entry.at || new Date(),
    event: String(entry.event || '').toLowerCase() || 'unknown',
    templateName: entry.templateName ? String(entry.templateName) : null,
    channel: entry.channel || 'template',
    success: !!entry.success,
    reason: entry.reason ? String(entry.reason).slice(0, 240) : null,
    source: entry.source ? String(entry.source).slice(0, 120) : 'system',
  };
  await Order.updateOne(
    { _id: orderId },
    { $push: { whatsappActivityLog: { $each: [row], $slice: -50 } } }
  ).catch((e) => {
    console.warn('[OrderWhatsAppActivity] log failed:', e.message);
  });
}

/** Resolve Mongo _id from order payload used in dispatchers. */
async function resolveOrderMongoId(order, clientId) {
  if (!order) return null;
  if (order._id) return order._id;
  const cid = clientId || order.clientId;
  if (order.orderId && cid) {
    const doc = await Order.findOne({ clientId: cid, orderId: order.orderId }).select('_id').lean();
    return doc?._id || null;
  }
  return null;
}

module.exports = {
  appendOrderWhatsAppActivity,
  resolveOrderMongoId,
};
