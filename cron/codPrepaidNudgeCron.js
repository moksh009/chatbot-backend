'use strict';

/**
 * Sends scheduled COD → prepaid nudges (delayMinutes from automation flow config).
 */

const cron = require('node-cron');
const Client = require('../models/Client');
const Order = require('../models/Order');
const log = require('../utils/core/logger')('CodPrepaidNudgeCron');
const { maybeDispatchCodPrepaidNudge } = require('../utils/commerce/codPrepaidDispatch');

async function runCodPrepaidNudgeTick() {
  try {
    const due = await Order.find({
      codNudgeStatus: 'scheduled',
      codNudgeScheduledAt: { $lte: new Date() },
      codNudgeSentAt: { $exists: false },
      paidViaLink: { $ne: true },
    })
      .limit(40)
      .lean();

    if (!due.length) return;

    for (const order of due) {
      const client = await Client.findOne({ clientId: order.clientId }).lean();
      if (!client) continue;

      const phone = order.customerPhone || order.phone;
      if (!phone) {
        await Order.findByIdAndUpdate(order._id, { $set: { codNudgeStatus: 'failed' } });
        continue;
      }

      const shopifyPayload = {
        id: order.shopifyOrderId || order.orderId,
        name: order.orderNumber || order.orderId,
        total_price: order.totalPrice || order.amount,
        customer: { first_name: (order.customerName || 'Customer').split(' ')[0] },
      };

      await maybeDispatchCodPrepaidNudge({
        client,
        orderDoc: order,
        shopifyPayload,
        phone,
        forceSend: true,
      }).catch((err) => {
        log.warn(`[CodPrepaidCron] ${order.clientId} ${order.orderId}: ${err.message}`);
      });
    }
  } catch (err) {
    log.error('[CodPrepaidCron] tick error:', { error: err.message });
  }
}

const codPrepaidNudgeCron = () => {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  cron.schedule('*/5 * * * *', runCodPrepaidNudgeTick);
};

codPrepaidNudgeCron.runTick = runCodPrepaidNudgeTick;
module.exports = codPrepaidNudgeCron;
