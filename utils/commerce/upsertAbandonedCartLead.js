'use strict';

const axios = require('axios');
const AdLead = require('../../models/AdLead');
const { trackEcommerceEvent } = require('../core/analyticsHelper');
const { logActivity } = require('../core/activityLogger');
const { recalculateLeadScore } = require('../core/scoringHelper');
const { normalizeIndianPhone, indianPhoneLookupVariants, indianPhoneDigits } = require('../core/normalizeIndianPhone');
const { contactPhoneKey } = require('./cartRecoveryAttemptService');
const { stitchCheckoutTokenToLead } = require('./visitorIdentityService');
const shopifyAdminApiVersion = require('../shopify/shopifyAdminApiVersion');
const log = require('../core/logger')('UpsertAbandonedCart');

async function enrichLineItemsWithImages(lineItems = [], client) {
  return Promise.all(
    lineItems.map(async (item) => {
      let imageUrl = item.image || item.image_url || item.imageUrl || null;
      const variantId = item.variant_id || item.productVariant || item.variantId;
      const productId = item.product_id || item.productId;

      if (!imageUrl && productId && client?.shopifyAccessToken && client?.shopDomain) {
        try {
          const res = await axios.get(
            `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/products/${productId}.json`,
            { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
          );
          imageUrl = res.data.product?.images?.[0]?.src || null;
        } catch {
          /* omit */
        }
      }

      if (!imageUrl && variantId && client?.shopifyAccessToken && client?.shopDomain) {
        try {
          const res = await axios.get(
            `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/variants/${variantId}.json`,
            { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
          );
          const pid = res.data?.variant?.product_id;
          if (pid) {
            const pres = await axios.get(
              `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/products/${pid}.json`,
              { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
            );
            imageUrl = pres.data.product?.images?.[0]?.src || null;
          }
        } catch {
          /* omit */
        }
      }

      return {
        variant_id: variantId ? String(variantId) : undefined,
        quantity: Number(item.quantity || item.productQuantity || item.qty || 1) || 1,
        image: imageUrl,
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

  const $set = {
    cartStatus,
    cartAbandonedAt: now,
    checkoutInitiatedAt: now,
    lastSeen: now,
    lastCartEventAt: now,
    checkoutUrl,
    isOrderPlaced: false,
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

  if (data.optStatus) {
    $set.optStatus = data.optStatus;
    if (data.optInSource) $set.optInSource = data.optInSource;
    if (data.optStatus === 'opted_in') {
      $set.optInDate = now;
      $set.whatsappMarketingEligible = !!phoneE164;
    }
  }

  const lead = await AdLead.findOneAndUpdate(
    leadQuery,
    {
      $set,
      $inc: {
        addToCartCount: enrichedItems.length || 1,
        checkoutInitiatedCount: 1,
      },
      $setOnInsert: {
        clientId,
        phoneNumber: phoneE164 || `unknown_checkout_${checkoutToken || Date.now()}`,
        source,
        createdAt: now,
      },
    },
    { upsert: true, new: true }
  );

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
        event: cartStatus === 'purchased' ? 'checkout_completed' : 'checkout_started',
        amount: Number(cartTotal) || 0,
        currency: data.currency || 'INR',
        timestamp: now,
      },
    },
  }).catch(() => {});

  await trackEcommerceEvent(clientId, { checkoutInitiatedCount: cartStatus === 'purchased' ? 0 : 1 });

  if (phoneE164 && cartStatus !== 'purchased') {
    try {
      const CartRecoveryAttempt = require('../../models/CartRecoveryAttempt');
      const contactPhone = contactPhoneKey(phoneE164) || phoneDigits;
      await CartRecoveryAttempt.create({
        clientId,
        leadId: lead._id,
        contactPhone,
        attemptTimestamp: now,
        messaged: false,
        recovered: false,
        status: 'pending',
      });
    } catch (craErr) {
      log.warn(`[CartRecovery] attempt create failed: ${craErr.message}`);
    }
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

  return { success: !!lead, lead };
}

module.exports = {
  upsertAbandonedCartLead,
  markCartLeadPurchased,
  enrichLineItemsWithImages,
  normalizeIncomingCartItems,
};
