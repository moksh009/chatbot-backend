'use strict';

const ProductWatch = require('../../models/ProductWatch');
const Client = require('../../models/Client');
const { sendEnvelope } = require('../../utils/messaging/sendEnvelope');
const { getPrebuiltByKey } = require('../../constants/prebuiltTemplateLibrary');
const log = require('../../utils/core/logger')('RestockNotify');

function activeStatusFilter() {
  return { status: { $in: ['active', 'watching'] } };
}

async function triggerRestockNotifications({ clientId, sku, productName, productUrl, currentStock }) {
  const watches = await ProductWatch.find({
    clientId,
    sku: String(sku),
    ...activeStatusFilter(),
  }).lean();

  if (!watches.length) return { sent: 0, expired: 0 };

  const client = await Client.findOne({ clientId }).lean();
  const prebuilt = getPrebuiltByKey('product_back_in_stock');
  const cycle = new Date().toISOString().slice(0, 10);
  let sent = 0;
  let expired = 0;

  for (const watch of watches) {
    const idempotencyKey = `restock:${sku}:${watch.leadId}:${cycle}`;
    const payload = {
      type: 'text',
      body:
        `Good news! *${productName || watch.productName}* is back in stock` +
        (currentStock ? ` (${currentStock} available)` : '') +
        (productUrl || watch.productUrl ? `\n${productUrl || watch.productUrl}` : ''),
    };

    if (prebuilt) {
      payload.type = 'template';
      payload.templateName = prebuilt.metaName || 'product_back_in_stock';
      payload.variables = {
        product_name: productName || watch.productName,
        product_url: productUrl || watch.productUrl || '',
      };
    }

    try {
      const result = await sendEnvelope({
        clientId,
        channel: 'whatsapp',
        intent: 'utility',
        contact: { phone: watch.phone },
        payload,
        idempotency: { key: idempotencyKey, ttlSec: 86400 },
        context: { source: 'product_watch_restock' },
      });

      if (result.status === 'sent' || result.status === 'queued') {
        await ProductWatch.updateOne(
          { _id: watch._id },
          { $set: { status: 'notified', notifiedAt: new Date(), lastStockSeen: currentStock || 0 } }
        );
        sent += 1;
      } else if (result.status === 'blocked') {
        await ProductWatch.updateOne(
          { _id: watch._id },
          {
            $set: {
              status: 'expired',
              cancelledReason: result.blockedBy || result.reason || 'envelope_blocked',
            },
          }
        );
        expired += 1;
      }
    } catch (e) {
      log.warn(`restock notify failed ${watch.phone}: ${e.message}`);
    }
  }

  return { sent, expired };
}

module.exports = { triggerRestockNotifications };
