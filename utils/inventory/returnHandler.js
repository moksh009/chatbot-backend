'use strict';

const ReturnEvent = require('../../models/ReturnEvent');
const { applyAdjustment } = require('./ledger');

async function inspectReturn(clientId, returnId, lineUpdates, { userId = '', name = '' } = {}) {
  const doc = await ReturnEvent.findOne({ clientId, _id: returnId });
  if (!doc) throw new Error('return_not_found');

  for (const upd of lineUpdates) {
    const line = doc.lineItems.id?.(upd.lineId) || doc.lineItems[upd.index];
    if (!line) continue;
    line.condition = upd.condition || line.condition;
    line.finalState = upd.finalState;
    line.inspectedAt = new Date();

    if (upd.finalState === 'restocked' && upd.restockQty > 0) {
      const key = `return:${returnId}:${line.sku}:${upd.index}`;
      await applyAdjustment({
        clientId,
        sku: line.sku,
        delta: Number(upd.restockQty) || Number(line.quantity) || 1,
        reason: 'return',
        source: 'manual_dashboard',
        sourceRef: String(returnId),
        idempotencyKey: key,
        createdBy: { userId, name },
      });
    }
  }

  doc.status = 'inspected';
  doc.events.push({
    at: new Date(),
    type: 'inspected',
    actor: { userId, name },
    notes: 'Inspection complete',
    channel: 'manual',
  });
  await doc.save();
  return doc;
}

module.exports = { inspectReturn };
