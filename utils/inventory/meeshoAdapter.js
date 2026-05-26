'use strict';

const { ChannelAdapter } = require('./channelAdapter');
const Order = require('../../models/Order');
const { applyAdjustment } = require('./ledger');
const log = require('../core/logger')('MeeshoAdapter');

class MeeshoAdapter extends ChannelAdapter {
  async verifyConnection() {
    return {
      ok: !!(this.config?.accessToken || this.config?.apiKey),
      limitations: 'Meesho API maturity varies; CSV import supported as fallback',
    };
  }

  async pullOrders({ since } = {}) {
    if (!this.config?.accessToken) {
      return { orders: [], skipped: true, reason: 'not_connected' };
    }
    log.info(`Meesho pullOrders stub for ${this.clientId}`);
    return { orders: [] };
  }

  async ingestOrder(orderPayload) {
    const orderId = orderPayload.orderId || orderPayload.id;
    const existing = await Order.findOne({ clientId: this.clientId, orderId, source: 'meesho' }).lean();
    if (existing) return { duplicate: true };

    await Order.create({
      clientId: this.clientId,
      orderId,
      source: 'meesho',
      status: orderPayload.status || 'pending',
      items: orderPayload.items || [],
      totalPrice: orderPayload.totalPrice || 0,
    });

    for (const item of orderPayload.items || []) {
      const sku = item.sku;
      if (!sku) continue;
      await applyAdjustment({
        clientId: this.clientId,
        sku,
        delta: -(Number(item.quantity) || 1),
        reason: 'other',
        source: 'manual_dashboard',
        sourceRef: orderId,
        idempotencyKey: `meesho:${orderId}:${item.lineItemId || sku}`,
      });
    }
    return { ingested: true };
  }
}

module.exports = { MeeshoAdapter };
