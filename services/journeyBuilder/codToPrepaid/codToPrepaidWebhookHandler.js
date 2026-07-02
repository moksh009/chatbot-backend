'use strict';

const CodToPrepaidConversion = require('../../../models/CodToPrepaidConversion');
const { deleteDraftOrder, cancelCodOrder, gidToNumericId } = require('./codToPrepaidShopify');
const { advanceJourneyToCodPrepaidConverted } = require('./codToPrepaidJourneyAdvance');
const log = require('../../../utils/core/logger')('CodToPrepaidWebhook');

const CONVERTED_TAG_RE = /^Converted_From_COD_(\d+)$/;

function extractConvertedCodOrderId(tags = []) {
  let list = tags;
  if (typeof tags === 'string') {
    list = tags.split(',').map((t) => t.trim()).filter(Boolean);
  } else if (!Array.isArray(tags)) {
    list = [];
  }
  for (const tag of list) {
    const m = CONVERTED_TAG_RE.exec(String(tag || '').trim());
    if (m) return m[1];
  }
  return '';
}

function resolveCodOrderGid(record, codOrderNumericId) {
  if (record?.originalCodOrderGid) return String(record.originalCodOrderGid);
  if (codOrderNumericId) return `gid://shopify/Order/${codOrderNumericId}`;
  return '';
}

function isCodFulfillmentExpiryTrigger(fulfillmentStatus) {
  const status = String(fulfillmentStatus || '').toLowerCase();
  return (
    status === 'in_progress' ||
    status === 'in progress' ||
    status === 'fulfilled' ||
    status === 'success'
  );
}

/**
 * Phase 3 — paid order with Converted_From_COD tag → cancel original COD order.
 */
async function handleCodToPrepaidPaidOrder({ clientId, shopifyOrder }) {
  if (!clientId || !shopifyOrder) return { handled: false };

  const codOrderId = extractConvertedCodOrderId(shopifyOrder.tags);
  if (!codOrderId) return { handled: false };

  const prepaidNumericId = String(shopifyOrder.id || gidToNumericId(shopifyOrder.admin_graphql_api_id) || '');
  const prepaidGid =
    shopifyOrder.admin_graphql_api_id ||
    (prepaidNumericId ? `gid://shopify/Order/${prepaidNumericId}` : '');

  const record = await CodToPrepaidConversion.findOne({
    clientId,
    originalCodOrderId: codOrderId,
  }).sort({ createdAt: -1 });

  if (!record) {
    log.warn('COD prepaid conversion tag but no record', { clientId, codOrderId });
    return { handled: true, skipped: true, reason: 'no_record' };
  }

  if (record.status === 'converted') {
    return { handled: true, skipped: true, reason: 'already_converted' };
  }

  await CodToPrepaidConversion.findByIdAndUpdate(record._id, {
    $set: {
      status: 'converted',
      convertedAt: new Date(),
      convertedPrepaidOrderId: prepaidNumericId,
      convertedPrepaidOrderGid: prepaidGid,
    },
  });

  const cancelOrderGid = resolveCodOrderGid(record, codOrderId);
  const cancelResult = await cancelCodOrder(clientId, cancelOrderGid);
  if (cancelResult.ok) {
    await CodToPrepaidConversion.findByIdAndUpdate(record._id, {
      $set: {
        codCancellationJobId: cancelResult.job?.id || '',
        codCancelledAt: new Date(),
        codCancellationFailed: false,
        codCancellationError: '',
      },
    });
  } else {
    const errMsg = cancelResult.userErrors?.[0]?.message || 'order_cancel_failed';
    log.error('orderCancel failed for COD prepaid', {
      clientId,
      conversionId: String(record._id),
      orderId: cancelOrderGid,
      userErrors: cancelResult.userErrors,
    });
    await CodToPrepaidConversion.findByIdAndUpdate(record._id, {
      $set: {
        codCancellationFailed: true,
        codCancellationError: errMsg,
      },
    });
  }

  if (record.graphNodeId) {
    await advanceJourneyToCodPrepaidConverted({
      clientId,
      enrollmentId: record.enrollmentId,
      graphNodeId: record.graphNodeId,
    }).catch((err) => {
      log.warn(`converted branch advance failed: ${err.message}`);
    });
  }

  return { handled: true, conversionId: String(record._id) };
}

/**
 * Phase 2B — fulfillment webhook expires draft when COD order ships.
 */
async function handleCodToPrepaidFulfillmentExpiry({
  clientId,
  orderId,
  fulfillmentStatus,
}) {
  if (!clientId || !orderId) return { handled: false };

  const numericId = String(orderId).replace(/\D/g, '');
  const orderGid = `gid://shopify/Order/${numericId}`;
  const status = String(fulfillmentStatus || '').toLowerCase();
  const normalizedStatus = status || (orderId ? 'fulfilled' : '');

  if (!isCodFulfillmentExpiryTrigger(normalizedStatus)) return { handled: false };

  const alreadyResolved = await CodToPrepaidConversion.findOne({
    clientId,
    originalCodOrderGid: orderGid,
    status: { $in: ['converted', 'expired_by_fulfillment'] },
  })
    .select('_id status')
    .lean();
  if (alreadyResolved) {
    return { handled: true, skipped: true, reason: 'already_resolved' };
  }

  const record = await CodToPrepaidConversion.findOne({
    clientId,
    originalCodOrderGid: orderGid,
    freezeMode: 'by_fulfillment_status',
    status: 'message_sent',
  }).lean();

  if (!record) return { handled: false };
  if (['converted', 'expired_by_fulfillment', 'expired_by_timer'].includes(record.status)) {
    return { handled: true, skipped: true };
  }

  const del = await deleteDraftOrder(clientId, record.draftOrderGid);
  if (!del.ok && !del.notFound) {
    log.warn('fulfillment expiry draft delete failed — will retry on next webhook', {
      clientId,
      conversionId: String(record._id),
      userErrors: del.userErrors,
    });
    await new Promise((r) => setTimeout(r, 5000));
    const retry = await deleteDraftOrder(clientId, record.draftOrderGid);
    if (!retry.ok && !retry.notFound) {
      log.error('fulfillment expiry draft delete retry failed', {
        clientId,
        conversionId: String(record._id),
        userErrors: retry.userErrors,
      });
      return { handled: true, failed: true };
    }
  }

  await CodToPrepaidConversion.findByIdAndUpdate(record._id, {
    $set: { status: 'expired_by_fulfillment', expiredAt: new Date() },
  });

  return { handled: true, conversionId: String(record._id) };
}

module.exports = {
  CONVERTED_TAG_RE,
  extractConvertedCodOrderId,
  isCodFulfillmentExpiryTrigger,
  handleCodToPrepaidPaidOrder,
  handleCodToPrepaidFulfillmentExpiry,
};
