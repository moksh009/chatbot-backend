'use strict';

const mongoose = require('mongoose');
const AdLead = require('../../models/AdLead');
const { attributeOrderToRecoveryAttempt } = require('../commerce/cartRecoveryAttemptService');
const { ABANDONED_CART_TAG, RECOVERED_CART_TAG } = require('../../constants/cartRecoveryTags');
const { getAppRedis } = require('../core/redisFactory');
const {
  applyMongoCancellations,
  finishCancelSideEffects,
} = require('../messaging/cancelAllAutomationsFor');
const { indianPhoneLookupVariants } = require('../core/normalizeIndianPhone');
const { buildOrderPlacedOptInSetFields } = require('../commerce/marketingOptStatusRules');
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

async function findRecoveryLead(clientId, data, cleanPhone) {
  const checkoutToken = data.checkout_token || data.token || '';
  const cartToken = data.cart_token || '';
  const phoneLookup = cleanPhone ? indianPhoneLookupVariants(cleanPhone) : [];

  if (checkoutToken) {
    const byCheckout = await AdLead.findOne({ clientId, checkoutToken: String(checkoutToken) });
    if (byCheckout) return byCheckout;
  }

  if (cartToken) {
    const byCart = await AdLead.findOne({ clientId, cartToken: String(cartToken) });
    if (byCart) return byCart;
  }

  if (phoneLookup.length) {
    const byPhone = await AdLead.findOne({
      clientId,
      phoneNumber: { $in: phoneLookup },
      cartStatus: { $in: ['abandoned', 'active', 'checkout_started'] },
    });
    if (byPhone) return byPhone;
  }

  if (phoneLookup.length) {
    return AdLead.findOne({ clientId, phoneNumber: { $in: phoneLookup } });
  }

  return null;
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
  const orderValue = parseFloat(data.total_price) || 0;

  const existingLead = await findRecoveryLead(client.clientId, data, cleanPhone);
  const phoneLookup = cleanPhone ? indianPhoneLookupVariants(cleanPhone) : [];
  const primaryPhone = phoneLookup[0] || cleanPhone;
  const leadFilter = existingLead
    ? { _id: existingLead._id, clientId: client.clientId }
    : primaryPhone
      ? { clientId: client.clientId, phoneNumber: { $in: phoneLookup.length ? phoneLookup : [primaryPhone] } }
      : null;

  if (!leadFilter) {
    if (orderId) await releaseOrderClaim(client.clientId, orderId);
    return { duplicate: false, lead: null, cancelled: { sequences: 0, campaignMessages: 0, scheduledMessages: 0 } };
  }

  const orderOptInFields = buildOrderPlacedOptInSetFields(existingLead?.optStatus);

  const recoveryStep = Number(existingLead?.recoveryStep || 0);
  let recoveredViaWhatsApp = recoveryStep > 0;

  let lead = null;
  let recoveryAttempt = null;
  let cancelled = { sequences: 0, campaignMessages: 0, scheduledMessages: 0 };
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      if (existingLead?._id) {
        recoveryAttempt = await attributeOrderToRecoveryAttempt(client.clientId, data, cleanPhone);
        if (recoveryAttempt?.recoveredViaWhatsapp) recoveredViaWhatsApp = true;
      }

      lead = await AdLead.findOneAndUpdate(
        leadFilter,
        {
          $set: {
            isOrderPlaced: true,
            cartStatus: recoveryAttempt?.recoveredViaWhatsapp ? 'recovered' : 'purchased',
            lastPurchaseDate: orderDate,
            lastOrderAt: orderDate,
            lastOrderId,
            source: 'shopify',
            isRtoRisk: false,
            recoveredAt: orderDate,
            abandonedCartRecoveredAt: orderDate,
            recoveredOrderId: String(data.id || data.name || ''),
            recoveredViaWhatsApp,
            ...orderOptInFields,
            ...(cleanPhone ? { phoneNumber: cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}` } : {}),
            ...(data.cart_token ? { cartToken: String(data.cart_token) } : {}),
            ...(data.checkout_token ? { checkoutToken: String(data.checkout_token) } : {}),
          },
          $pull: { tags: { $in: [ABANDONED_CART_TAG, 'Imported'] } },
          $addToSet: { tags: RECOVERED_CART_TAG },
          $inc: {
            ordersCount: 1,
            totalSpent: orderValue,
            lifetimeValue: orderValue,
          },
        },
        { new: true, session, upsert: !existingLead, setDefaultsOnInsert: true }
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

  return {
    duplicate: false,
    lead,
    cancelled,
    recoveryMatched: !!existingLead,
    recoveryAttempt,
  };
}

module.exports = {
  handleOrderAtomic,
  findRecoveryLead,
  claimOrderProcessing,
  releaseOrderClaim,
  orderDedupKey,
};
