'use strict';

const StockoutEvent = require('../../models/StockoutEvent');

async function onStockChange({ clientId, sku, locationId = 'default', qtyBefore, qtyAfter, channels = ['shopify'] }) {
  const before = Number(qtyBefore) || 0;
  const after = Number(qtyAfter) || 0;

  if (before > 0 && after <= 0) {
    const open = await StockoutEvent.findOne({ clientId, sku, status: 'open' }).lean();
    if (!open) {
      await StockoutEvent.create({
        clientId,
        sku,
        locationId,
        startedAt: new Date(),
        channelsAffected: channels,
        status: 'open',
      });
    }
  }

  if (before <= 0 && after > 0) {
    const open = await StockoutEvent.findOne({ clientId, sku, status: 'open' }).sort({ startedAt: -1 });
    if (open) {
      const ended = new Date();
      const hours = (ended - new Date(open.startedAt)) / (60 * 60 * 1000);
      open.endedAt = ended;
      open.durationHours = Number(hours.toFixed(2));
      open.status = 'closed';
      await open.save();
    }
  }
}

async function enrichStockoutEstimates(clientId, events, orders) {
  return events.map((ev) => {
    const skuOrders = orders.filter((o) =>
      (o.items || []).some((i) => i.sku === ev.sku)
    );
    const revenue = skuOrders.reduce((a, o) => a + (Number(o.totalPrice) || 0), 0);
    const units = skuOrders.reduce(
      (a, o) => a + (o.items || []).filter((i) => i.sku === ev.sku).reduce((s, i) => s + (Number(i.quantity) || 1), 0),
      0
    );
    const aov = skuOrders.length ? revenue / skuOrders.length : 0;
    const vel = units / 30;
    const lost = (ev.durationHours || 24) / 24 * vel * aov;
    return { ...ev, estimatedLostSales: Math.round(lost) };
  });
}

module.exports = { onStockChange, enrichStockoutEstimates };
