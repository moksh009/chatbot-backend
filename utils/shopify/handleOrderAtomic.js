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
const { indianPhoneLookupVariants, indianPhoneSuffix } = require('../core/normalizeIndianPhone');
const { normalizeEmail } = require('../commerce/marketingConsent');
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
  const orderEmail = normalizeEmail(
    data.email || data.contact_email || data.customer?.email || data.billing_address?.email
  );

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

    const suffix = indianPhoneSuffix(cleanPhone);
    if (suffix.length >= 8) {
      const bySuffix = await AdLead.findOne({
        clientId,
        phoneNumber: { $regex: new RegExp(`${suffix}$`) },
        cartStatus: { $in: ['abandoned', 'active', 'checkout_started'] },
      });
      if (bySuffix) return bySuffix;
    }
  }

  if (orderEmail) {
    const byEmail = await AdLead.findOne({
      clientId,
      email: orderEmail,
      cartStatus: { $in: ['abandoned', 'active', 'checkout_started'] },
    });
    if (byEmail) return byEmail;
  }

  if (phoneLookup.length) {
    const anyPhone = await AdLead.findOne({ clientId, phoneNumber: { $in: phoneLookup } });
    if (anyPhone) return anyPhone;

    const suffix = indianPhoneSuffix(cleanPhone);
    if (suffix.length >= 8) {
      return AdLead.findOne({
        clientId,
        phoneNumber: { $regex: new RegExp(`${suffix}$`) },
      });
    }
  }

  if (orderEmail) {
    return AdLead.findOne({ clientId, email: orderEmail });
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
  if (existingLead && !Array.isArray(existingLead.tags)) {
    const withTags = await AdLead.findById(existingLead._id).select('tags').lean();
    if (withTags) existingLead.tags = withTags.tags;
  }
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
  let recoveredViaWhatsApp = false;
  let recoveredByStep = null;

  let lead = null;
  let recoveryAttempt = null;
  let cancelled = { sequences: 0, campaignMessages: 0, scheduledMessages: 0 };
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      if (existingLead?._id) {
        recoveryAttempt = await attributeOrderToRecoveryAttempt(client.clientId, data, cleanPhone);
        if (recoveryAttempt?.recoveredViaWhatsapp) recoveredViaWhatsApp = true;
        if (recoveryAttempt?.recoveredViaWhatsapp) {
          const sentSteps = (recoveryAttempt.whatsappTemplatesSent || [])
            .map((t) => Number(t.followupNumber))
            .filter((n) => n > 0);
          recoveredByStep = sentSteps.length
            ? Math.max(...sentSteps)
            : recoveryStep > 0
              ? recoveryStep
              : 1;
        }
      }

      const priorTags = Array.isArray(existingLead?.tags) ? existingLead.tags : [];
      const nextTags = [
        ...new Set([
          ...priorTags.filter((t) => t !== ABANDONED_CART_TAG && t !== 'Imported'),
          RECOVERED_CART_TAG,
        ]),
      ];

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
            tags: nextTags,
            ...(recoveredByStep != null ? { recoveredByStep } : {}),
            ...orderOptInFields,
            ...(cleanPhone ? { phoneNumber: cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}` } : {}),
            ...(data.cart_token ? { cartToken: String(data.cart_token) } : {}),
            ...(data.checkout_token ? { checkoutToken: String(data.checkout_token) } : {}),
          },
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

      if (existingLead && (recoveryAttempt || lead.cartStatus === 'recovered' || lead.cartStatus === 'purchased')) {
        const { emitCartRecovered } = require('../commerce/pixelSocketEmit');
        emitCartRecovered(client.clientId, {
          leadId: String(lead._id),
          orderId: String(data.id || data.name || ''),
          orderValue,
          recoveredViaWhatsapp: recoveredViaWhatsApp,
          recoveredByStep,
          revenue: orderValue,
        });
      }

      const { attachVisitorJourneyOnOrder } = require('../commerce/attachVisitorJourneyOnOrder');
      attachVisitorJourneyOnOrder(client, lead, data).catch((e) =>
        log.warn(`Visitor journey stitch failed: ${e.message}`)
      );

      const { maybeAttributeQrConversion } = require('../commerce/qrInboundHandler');
      maybeAttributeQrConversion(client.clientId, cleanPhone, lead).catch((e) =>
        log.warn(`QR conversion attribution failed: ${e.message}`)
      );
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
