'use strict';

const axios = require('axios');
const AdLead = require('../../models/AdLead');
const { trackEcommerceEvent } = require('../core/analyticsHelper');
const { logActivity } = require('../core/activityLogger');
const { recalculateLeadScore } = require('../core/scoringHelper');
const { normalizeIndianPhone, indianPhoneLookupVariants, indianPhoneDigits } = require('../core/normalizeIndianPhone');
const { contactPhoneKey, ensureCartRecoveryAttempt } = require('./cartRecoveryAttemptService');
const { ABANDONED_CART_TAG, RECOVERED_CART_TAG } = require('../../constants/cartRecoveryTags');
const { stitchCheckoutTokenToLead } = require('./visitorIdentityService');
const { attachAnonymousJourneyToLead } = require('./attachAnonymousJourney');
const { withPixelCaptureLock } = require('./pixelCaptureLock');
const { extractUtmFields } = require('./pixelUtmUtils');
const { emitCartContactCaptured } = require('./pixelSocketEmit');
const { buildLeadRecoveryBaseUrl } = require('./buildRecoveryUrl');
const { cartValueTier } = require('./cartValueTier');
const {
  getCartRecoveryConfig,
  computeNextPromotionAt,
} = require('./cartRecoveryConfigService');
const shopifyAdminApiVersion = require('../shopify/shopifyAdminApiVersion');
const log = require('../core/logger')('UpsertAbandonedCart');

async function fetchShopifyProductImage(client, productId) {
  if (!productId || !client?.shopifyAccessToken || !client?.shopDomain) return null;
  try {
    const res = await axios.get(
      `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/products/${productId}.json`,
      { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken }, timeout: 8000 }
    );
    return res.data?.product?.images?.[0]?.src || res.data?.product?.image?.src || null;
  } catch {
    return null;
  }
}

async function enrichLineItemsWithImages(lineItems = [], client) {
  return Promise.all(
    lineItems.map(async (item) => {
      let imageUrl =
        item.image ||
        item.image_url ||
        item.imageUrl ||
        item.featured_image?.src ||
        item.variant_image?.src ||
        null;
      const variantId = item.variant_id || item.productVariant || item.variantId;
      const productId = item.product_id || item.productId;

      if (!imageUrl && productId) {
        imageUrl = await fetchShopifyProductImage(client, productId);
      }

      if (!imageUrl && variantId && client?.shopifyAccessToken && client?.shopDomain) {
        try {
          const res = await axios.get(
            `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/variants/${variantId}.json`,
            { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken }, timeout: 8000 }
          );
          imageUrl = res.data?.variant?.image?.src || res.data?.variant?.image_url || null;
          const pid = res.data?.variant?.product_id;
          if (!imageUrl && pid) {
            imageUrl = await fetchShopifyProductImage(client, pid);
          }
        } catch {
          /* omit */
        }
      }

      return {
        variant_id: variantId ? String(variantId) : undefined,
        product_id: productId ? String(productId) : undefined,
        quantity: Number(item.quantity || item.productQuantity || item.qty || 1) || 1,
        image: imageUrl,
        image_url: imageUrl,
        imageUrl,
        title: item.title || item.name || item.productName || item.product_title || 'Item',
        name: item.name || item.productName || item.title,
        price: item.price ?? item.productPrice ?? item.line_price ?? '',
      };
    })
  );
}

function normalizeIncomingCartItems(rawItems = []) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map((item) => ({
    variant_id: item.variant_id || item.productVariant || item.variantId,
    product_id: item.product_id || item.productId,
    quantity: Number(item.quantity || item.productQuantity || item.qty || 1) || 1,
    title: item.title || item.name || item.productName || item.product_title || 'Item',
    name: item.name || item.productName || item.title,
    price: item.price ?? item.productPrice ?? item.line_price ?? '',
    image: item.image || item.image_url || item.imageUrl || null,
  }));
}

/**
 * Shared abandoned-cart upsert for Shopify native, GoKwik, Razorpay, Shiprocket, pixel.
 * @param {object} client - Client doc (needs clientId, shopDomain, shopifyAccessToken)
 * @param {object} data
 */
async function upsertAbandonedCartLead(client, data = {}) {
  const clientId = data.clientId || client?.clientId;
  if (!clientId) return { success: false, reason: 'missing_client' };

  const phoneE164 = data.phone ? normalizeIndianPhone(data.phone) : null;
  const phoneLookup = phoneE164 ? indianPhoneLookupVariants(phoneE164) : [];
  const phoneDigits = phoneE164 ? indianPhoneDigits(phoneE164) : '';
  const email = data.email ? String(data.email).trim().toLowerCase() : null;

  if (!phoneE164 && !email) return { success: false, reason: 'missing_contact' };

  const rawItems = data.cartItems || data.line_items || [];
  const normalizedItems = normalizeIncomingCartItems(rawItems);
  const enrichedItems = await enrichLineItemsWithImages(normalizedItems, client);

  const checkoutToken = data.checkoutToken || data.checkout_token || data.cartId || '';
  const cartToken = data.cartToken || data.cart_token || '';
  const cartTotal = data.cartTotal ?? data.cart_total ?? data.total_price ?? null;
  const checkoutUrl = data.checkoutUrl || data.checkout_url || data.abandonLink || data.abandoned_checkout_url || '';
  const customerName = data.customerName || data.name || 'Checkout Customer';
  const source = data.source || 'shopify_native';
  const cartStatus = data.cartStatus || 'abandoned';
  const now = new Date();

  const leadQuery = phoneE164
    ? { clientId, phoneNumber: { $in: phoneLookup } }
    : { clientId, email };

  /** WS-3: completed checkouts must NOT enter recovery. Shopify sets
   *  `completed_at` on the checkout payload once the order is placed. */
  const completedAt = data.completedAt || data.completed_at || null;
  const finalCartStatus =
    completedAt || cartStatus === 'purchased' ? 'purchased' : cartStatus;
  const isPurchased = finalCartStatus === 'purchased';

  /** WS-3 C2: never downgrade a lead that's already `purchased` /
   *  `isOrderPlaced=true`. Shopify can send a late `checkouts/update`
   *  without `completed_at` after the order webhook already fired —
   *  re-opening the lead for recovery would message a customer who
   *  already paid. Refresh snapshot fields only. */
  const existing = await AdLead.findOne(leadQuery)
    .select('cartStatus isOrderPlaced recoveryStep _id contactCapturedAt checkoutToken')
    .lean();
  const alreadyPurchased =
    existing && (existing.cartStatus === 'purchased' || existing.isOrderPlaced === true);
  if (alreadyPurchased && !isPurchased) {
    log.info(
      `[UpsertCart] Skipping abandon downgrade for purchased lead ${clientId}/${phoneE164 || email}`
    );
    return {
      success: true,
      skipped: true,
      reason: 'already_purchased',
      lead: existing,
      phone: phoneE164,
      phoneDigits,
    };
  }

  /** Single-page checkout: webhook may fire many times while user edits.
   *  Keep `active` until cron promotes or order completes — do not flip to abandoned. */
  let resolvedCartStatus = finalCartStatus;
  if (
    existing?.cartStatus === 'active' &&
    !isPurchased &&
    resolvedCartStatus === 'abandoned'
  ) {
    resolvedCartStatus = 'active';
  }

  const $set = {
    cartStatus: resolvedCartStatus,
    lastSeen: now,
    lastCartEventAt: now,
    checkoutUrl,
    isOrderPlaced: isPurchased,
    cartSnapshot: {
      items: enrichedItems,
      updatedAt: now,
      checkoutUrl,
      checkoutToken: checkoutToken || '',
      total_price: cartTotal,
      currency: data.currency || 'INR',
    },
    source,
  };

  if (phoneE164) $set.phoneNumber = phoneE164;
  if (email) $set.email = email;
  if (customerName) $set.name = customerName;
  if (checkoutToken) $set.checkoutToken = String(checkoutToken);
  if (cartToken) $set.cartToken = String(cartToken);
  if (cartTotal != null && cartTotal !== '') $set.cartValue = Number(cartTotal) || 0;

  const recoveryBaseUrl = buildLeadRecoveryBaseUrl(client, {
    checkoutToken,
    checkoutUrl,
    cartSnapshot: { checkoutUrl, checkoutToken },
  });
  if (recoveryBaseUrl) $set.recoveryUrl = recoveryBaseUrl;
  if (cartTotal != null && cartTotal !== '') {
    $set.cartValueTier = cartValueTier(Number(cartTotal) || 0);
  }

  const utmFields = extractUtmFields(data);
  Object.assign($set, utmFields);

  if (resolvedCartStatus === 'active' || data.contactCapturedAt) {
    if (!existing?.contactCapturedAt) {
      $set.contactCapturedAt = data.contactCapturedAt || now;
    }
    const cfg = getCartRecoveryConfig(client);
    const promoAnchor = data.contactCapturedAt || existing?.contactCapturedAt || now;
    $set.nextPromotionAt = computeNextPromotionAt(
      {
        cartStatus: 'active',
        lastCartEventAt: now,
        contactCapturedAt: promoAnchor,
        cartAbandonedAt: existing?.cartAbandonedAt || now,
        createdAt: existing?.createdAt || now,
      },
      cfg.promotionDelayMinutes
    );
  }

  if (data.optStatus) {
    $set.optStatus = data.optStatus;
    if (data.optInSource) $set.optInSource = data.optInSource;
    if (data.optStatus === 'opted_in') {
      $set.optInDate = now;
      $set.whatsappMarketingEligible = !!phoneE164;
    }
  }

  /** New checkout session for same phone — restart recovery ladder (BUG-006). */
  if (
    !isPurchased &&
    checkoutToken &&
    existing?.checkoutToken &&
    String(checkoutToken) !== String(existing.checkoutToken)
  ) {
    $set.recoveryStep = 0;
    $set.cartAbandonedAt = now;
    $set.recoveryStartedAt = null;
  }

  /** WS-3: `cartAbandonedAt` is the cron's timer anchor — set it ONCE on
   *  first abandon. Re-stamping on every `checkouts/update` (Shopify fires
   *  many) would push the recovery timer forward forever and msg #1 would
   *  never reach 25 min elapsed. */
  const $setOnInsert = {
    clientId,
    createdAt: now,
  };
  if (!phoneE164) {
    $setOnInsert.phoneNumber = `unknown_checkout_${checkoutToken || Date.now()}`;
  }
  if (!isPurchased) {
    $setOnInsert.cartAbandonedAt = now;
    $setOnInsert.checkoutInitiatedAt = now;
  }

  const tagOps = isPurchased
    ? {
        $pull: { tags: ABANDONED_CART_TAG },
        $addToSet: { tags: RECOVERED_CART_TAG },
      }
    : resolvedCartStatus === 'abandoned' && phoneE164
      ? { $addToSet: { tags: ABANDONED_CART_TAG } }
      : {};

  const lead = await AdLead.findOneAndUpdate(
    leadQuery,
    {
      $set,
      $inc: {
        addToCartCount: enrichedItems.length || 1,
        checkoutInitiatedCount: 1,
      },
      $setOnInsert,
      ...tagOps,
    },
    { upsert: true, new: true }
  );

  /** Mark recovered + halt scheduler immediately if checkout completed. */
  if (isPurchased) {
    await AdLead.updateOne(leadQuery, {
      $set: {
        isOrderPlaced: true,
        cartStatus: 'purchased',
        recoveryStep: 99,
        cartRecoveredAt: now,
      },
    }).catch(() => {});
  }

  if (checkoutToken) {
    await stitchCheckoutTokenToLead(clientId, checkoutToken, phoneE164, email, client).catch((e) =>
      log.warn(`[UpsertCart] visitor stitch: ${e.message}`)
    );
  }

  if (phoneDigits) {
    const { updateLeadWithScoring } = require('./leadScoring');
    await updateLeadWithScoring(phoneDigits, clientId, {}, {}, {}).catch(() => {});
  }

  await AdLead.updateOne(leadQuery, {
    $push: {
      commerceEvents: {
        event: resolvedCartStatus === 'purchased' ? 'checkout_completed' : 'checkout_started',
        amount: Number(cartTotal) || 0,
        currency: data.currency || 'INR',
        timestamp: now,
      },
    },
  }).catch(() => {});

  await trackEcommerceEvent(clientId, {
    checkoutInitiatedCount: resolvedCartStatus === 'purchased' ? 0 : 1,
  });

  if (phoneE164 && resolvedCartStatus !== 'purchased' && resolvedCartStatus !== 'active') {
    await ensureCartRecoveryAttempt({
      clientId,
      leadId: lead._id,
      contactPhone: contactPhoneKey(phoneE164) || phoneDigits,
      checkoutToken,
      cartToken,
      attemptTimestamp: now,
    }).catch((craErr) => {
      log.warn(`[CartRecovery] attempt ensure failed: ${craErr.message}`);
    });
    await recalculateLeadScore(clientId, phoneDigits || phoneE164).catch(() => {});
  }

  if (data.logActivity !== false) {
    await logActivity(clientId, {
      type: 'LEAD',
      status: 'info',
      title: cartStatus === 'purchased' ? 'Cart Recovered' : 'Checkout Started',
      message: `${customerName} — ${enrichedItems.length} item(s) from ${source}`,
      icon: 'ShoppingCart',
      url: phoneE164 ? `/leads/${phoneE164}` : '/leads',
      metadata: { phone: phoneE164 || email, source, amount: cartTotal },
    }).catch(() => {});
  }

  if (lead?._id && !isPurchased) {
    await attachAnonymousJourneyToLead({
      clientId,
      leadId: lead._id,
      visitorId: data.visitorId,
      sessionId: data.sessionId,
      checkoutToken: data.checkoutToken || data.token || cartToken,
    }).catch(() => {});
  }

  if (lead?._id && !isPurchased && (phoneE164 || email)) {
    emitCartContactCaptured(clientId, {
      leadId: String(lead._id),
      phone: phoneE164,
      email,
      cartValue: Number(cartTotal) || lead.cartValue || 0,
      cartStatus: resolvedCartStatus,
      source,
      checkoutToken: checkoutToken || null,
    });
    if (global.io) {
      global.io.to(`client_${clientId}`).emit('lead_cart_update', {
        leadId: lead._id,
        phone: phoneE164 || lead.phoneNumber,
        cartStatus: resolvedCartStatus,
        cartValue: Number(cartTotal) || lead.cartValue,
        event: 'checkout_contact_captured',
      });
    }
  }

  return { success: true, lead, phone: phoneE164, phoneDigits };
}

/**
 * Mark lead as purchased (GoKwik recovered callback, etc.)
 */
async function markCartLeadPurchased(clientId, { phone, checkoutToken, cartToken, orderId, orderValue } = {}) {
  const phoneE164 = phone ? normalizeIndianPhone(phone) : null;
  const phoneLookup = phoneE164 ? indianPhoneLookupVariants(phoneE164) : [];
  const or = [];
  if (checkoutToken) or.push({ checkoutToken: String(checkoutToken) });
  if (cartToken) or.push({ cartToken: String(cartToken) });
  if (phoneE164) or.push({ phoneNumber: { $in: phoneLookup } });

  if (!or.length) return { success: false, reason: 'no_match_keys' };

  const now = new Date();
  const lead = await AdLead.findOneAndUpdate(
    { clientId, $or: or },
    {
      $set: {
        cartStatus: 'purchased',
        isOrderPlaced: true,
        recoveredAt: now,
        recoveredOrderId: orderId ? String(orderId) : undefined,
      },
      $pull: { tags: ABANDONED_CART_TAG },
      $addToSet: { tags: RECOVERED_CART_TAG },
    },
    { new: true }
  );

  if (lead && phoneE164) {
    const { attributeOrderToRecoveryAttempt } = require('./cartRecoveryAttemptService');
    await attributeOrderToRecoveryAttempt(
      clientId,
      { id: orderId, total_price: orderValue },
      phoneE164
    );
  }

  if (lead && global.io) {
    try {
      const { emitCartRecovered } = require('./pixelSocketEmit');
      emitCartRecovered(clientId, {
        leadId: String(lead._id),
        phone: phoneE164 || lead.phoneNumber,
        orderId: orderId ? String(orderId) : null,
        orderValue: orderValue != null ? Number(orderValue) : null,
      });
    } catch (_) {
      /* non-fatal */
    }
  }

  return { success: !!lead, lead };
}

module.exports = {
  upsertAbandonedCartLead,
  markCartLeadPurchased,
  enrichLineItemsWithImages,
  normalizeIncomingCartItems,
  fetchShopifyProductImage,
};
