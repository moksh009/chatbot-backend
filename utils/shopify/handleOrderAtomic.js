const mongoose = require('mongoose');
const AdLead = require('../../models/AdLead');
const { getAppRedis } = require('../core/redisFactory');
const {
  applyMongoCancellations,
  finishCancelSideEffects,
} = require('../messaging/cancelAllAutomationsFor');
const log = require('../core/logger')('HandleOrderAtomic');

const ORDER_DEDUP_TTL_SEC = 7 * 24 * 3600;

function orderDedupKey(clientId, orderId) {
  return `shopify_order_processed:${clientId}:${orderId}`;
}

async function claimOrderProcessing(clientId, orderId) {
  const redis = getAppRedis();
  if (!redis || !orderId) return { duplicate: false, claimed: true };
  try {
    const key = orderDedupKey(clientId, orderId);
    const set = await redis.set(key, '1', 'EX', ORDER_DEDUP_TTL_SEC, 'NX');
    if (set === null) {
      const existing = await redis.get(key);
      return { duplicate: !!existing, claimed: false };
    }
    return { duplicate: false, claimed: true };
  } catch (e) {
    log.warn(`Order dedup SETNX failed: ${e.message}`);
    return { duplicate: false, claimed: true };
  }
}

async function releaseOrderClaim(clientId, orderId) {
  const redis = getAppRedis();
  if (!redis || !orderId) return;
  try {
    await redis.del(orderDedupKey(clientId, orderId));
  } catch {
    /* ignore */
  }
}

/**
 * Atomic purchase side-effects: lead flags + automation cancel (Mongo transaction).
 */
async function handleOrderAtomic(client, data, cleanPhone) {
  const orderId = String(data.id || data.name || '');
  if (orderId) {
    const claim = await claimOrderProcessing(client.clientId, orderId);
    if (claim.duplicate) return { duplicate: true, lead: null };
  }

  const orderDate = data.created_at ? new Date(data.created_at) : new Date();
  const lastOrderId = data.name || String(data.id || '');

  let lead = null;
  let cancelled = { sequences: 0, campaignMessages: 0, scheduledMessages: 0 };
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      lead = await AdLead.findOneAndUpdate(
        { phoneNumber: cleanPhone, clientId: client.clientId },
        {
          $set: {
            isOrderPlaced: true,
            cartStatus: 'purchased',
            lastOrderAt: orderDate,
            lastOrderId,
            isRtoRisk: false,
          },
          $inc: { ordersCount: 1 },
        },
        { new: true, session, upsert: true }
      );

      cancelled = await applyMongoCancellations(
        {
          clientId: client.clientId,
          leadId: lead?._id,
          phone: cleanPhone,
          reason: 'order_placed',
          channels: 'all',
        },
        session
      );
    });
  } catch (err) {
    if (orderId) await releaseOrderClaim(client.clientId, orderId);
    throw err;
  } finally {
    session.endSession();
  }

  setImmediate(() => {
    finishCancelSideEffects(
      {
        clientId: client.clientId,
        leadId: lead?._id,
        phone: cleanPhone,
        reason: 'order_placed',
        channels: 'all',
        actor: { type: 'system', source: 'shopify_webhook:orders/create' },
      },
      cancelled
    ).catch((e) => log.warn(`Post-order cancel side effects: ${e.message}`));

    if (lead) {
      const { schedulePostPurchaseEnrollment } = require('../../services/postPurchaseJourneys/enroll');
      schedulePostPurchaseEnrollment({
        client,
        orderPayload: data,
        shopifyTopic: 'orders/create',
        storeKey: client.shopDomain || '',
      });
    }
  });

  return { duplicate: false, lead, cancelled };
}

module.exports = {
  handleOrderAtomic,
  claimOrderProcessing,
  releaseOrderClaim,
  orderDedupKey,
};
