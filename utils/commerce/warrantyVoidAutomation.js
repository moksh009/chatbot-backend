'use strict';

const WarrantyRecord = require('../../models/WarrantyRecord');
const log = require('../core/logger')('WarrantyVoidAutomation');

function orderKeysFromPayload(order = {}) {
  const raw = [order.name, order.id, order.order_number, order.orderNumber]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const keys = new Set(raw);
  raw.forEach((v) => {
    if (/^\d+$/.test(v)) keys.add(`#${v}`);
  });
  return [...keys];
}

function parseRefundedProductIds(refundPayload = {}) {
  const rows = Array.isArray(refundPayload.refund_line_items) ? refundPayload.refund_line_items : [];
  return [
    ...new Set(
      rows
        .map((row) => row?.line_item?.product_id || row?.product_id || null)
        .filter((id) => id !== null && id !== undefined)
        .map((id) => String(id).trim())
        .filter(Boolean)
    ),
  ];
}

async function applyWarrantyVoidFromOrder({
  clientId,
  orderPayload,
  refundedProductIds = [],
  source = 'unknown',
}) {
  const orderKeys = orderKeysFromPayload(orderPayload);
  if (!clientId || !orderKeys.length) return { matched: 0, modified: 0 };

  const filter = {
    clientId,
    shopifyOrderId: { $in: orderKeys },
    status: { $ne: 'void' },
  };

  const ids = Array.isArray(refundedProductIds) ? refundedProductIds.map(String).filter(Boolean) : [];
  if (ids.length) filter.productId = { $in: ids };

  const result = await WarrantyRecord.updateMany(filter, {
    $set: { status: 'void' },
  });

  const modified = Number(result.modifiedCount || result.nModified || 0);
  if (modified > 0) {
    log.info(`[${source}] set ${modified} warranty records to void`);
  }
  return { matched: Number(result.matchedCount || 0), modified };
}

module.exports = {
  orderKeysFromPayload,
  parseRefundedProductIds,
  applyWarrantyVoidFromOrder,
};
