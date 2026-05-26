'use strict';

const { ChannelAdapter } = require('./channelAdapter');
const Order = require('../../models/Order');
const { applyAdjustment } = require('./ledger');
const log = require('../core/logger')('FlipkartAdapter');

class FlipkartAdapter extends ChannelAdapter {
  async verifyConnection() {
    return {
      ok: !!(this.config?.apiKey && this.config?.apiSecret),
      limitations: 'Flipkart Seller API — orders/returns; inventory push via listings',
    };
  }

  async pullOrders() {
    if (!this.config?.apiKey) return { orders: [], skipped: true };
    log.info(`Flipkart pullOrders stub for ${this.clientId}`);
    return { orders: [] };
  }

  async ingestOrder(orderPayload) {
    const orderId = orderPayload.orderId || orderPayload.id;
    const existing = await Order.findOne({ clientId: this.clientId, orderId, source: 'flipkart' }).lean();
    if (existing) return { duplicate: true };

    await Order.create({
      clientId: this.clientId,
      orderId,
      source: 'flipkart',
      status: orderPayload.status || 'pending',
      items: orderPayload.items || [],
      totalPrice: orderPayload.totalPrice || 0,
    });

    for (const item of orderPayload.items || []) {
      if (!item.sku) continue;
      await applyAdjustment({
        clientId: this.clientId,
        sku: item.sku,
        delta: -(Number(item.quantity) || 1),
        reason: 'other',
        source: 'manual_dashboard',
        sourceRef: orderId,
        idempotencyKey: `flipkart:${orderId}:${item.lineItemId || item.sku}`,
      });
    }
    return { ingested: true };
  }
}

module.exports = { FlipkartAdapter };
