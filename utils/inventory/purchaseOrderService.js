'use strict';

const PurchaseOrder = require('../../models/PurchaseOrder');
const Supplier = require('../../models/Supplier');
const { applyAdjustment } = require('./ledger');
const { nextPoNumber } = require('./restockSuggestionEngine');

async function receivePurchaseOrder(clientId, poId, lineReceipts, { userId = '', name = '' } = {}) {
  const po = await PurchaseOrder.findOne({ clientId, _id: poId });
  if (!po) throw new Error('po_not_found');

  const lines = po.lineItems?.length ? po.lineItems : po.items || [];
  let allReceived = true;

  for (const receipt of lineReceipts) {
    const line = lines.find((l) => l.sku === receipt.sku);
    if (!line) continue;
    const qty = Number(receipt.receivedQuantity) || 0;
    if (qty <= 0) continue;

    line.receivedQuantity = (line.receivedQuantity || 0) + qty;
    line.receivedAt = new Date();

    await applyAdjustment({
      clientId,
      sku: line.sku,
      delta: qty,
      reason: 'received_shipment',
      source: 'manual_dashboard',
      sourceRef: String(poId),
      idempotencyKey: `po:${poId}:${line.sku}:recv:${line.receivedQuantity}`,
      createdBy: { userId, name },
    });

    if (line.receivedQuantity < line.quantity) allReceived = false;
  }

  po.lineItems = lines;
  po.items = lines;
  po.status = allReceived ? 'received' : 'partially_received';
  if (allReceived) po.actualDeliveryDate = new Date();
  po.events.push({
    at: new Date(),
    type: 'received',
    actor: { userId, name },
    notes: 'Shipment received',
    channel: 'manual',
  });
  await po.save();

  const supplier = await Supplier.findById(po.supplierId);
  if (supplier) {
    supplier.totalOrders = (supplier.totalOrders || 0) + 1;
    await supplier.save();
  }

  const { fulfillBackordersFifo } = require('./backorderHandler');
  for (const receipt of lineReceipts) {
    await fulfillBackordersFifo({ clientId, sku: receipt.sku, incomingQty: receipt.receivedQuantity });
  }

  return po;
}

async function createPurchaseOrder(clientId, payload) {
  const poNumber = payload.poNumber || (await nextPoNumber(clientId));
  const lineItems = (payload.lineItems || []).map((l) => ({
    sku: l.sku,
    productName: l.productName || l.sku,
    quantity: l.quantity,
    unitCost: l.unitCost || 0,
    currency: l.currency || 'INR',
  }));
  const subtotal = lineItems.reduce((a, l) => a + l.quantity * l.unitCost, 0);

  return PurchaseOrder.create({
    clientId,
    poNumber,
    supplierId: payload.supplierId,
    status: payload.status || 'draft',
    lineItems,
    items: lineItems,
    subtotal,
    total: subtotal + (payload.tax || 0),
    totalCost: subtotal,
    tax: payload.tax || 0,
    currency: payload.currency || 'INR',
    expectedDeliveryDate: payload.expectedDeliveryDate,
    generatedBy: payload.generatedBy || 'manual_merchant',
    events: [{ type: 'created', notes: payload.notes || '' }],
  });
}

module.exports = { receivePurchaseOrder, createPurchaseOrder };
