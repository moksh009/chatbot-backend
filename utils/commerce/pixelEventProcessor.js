"use strict";

const AdLead = require("../../models/AdLead");
const PixelEvent = require("../../models/PixelEvent");
const { normalizePhoneWithCountry } = require("../core/helpers");
const { stitchVisitorIdentity } = require("./visitorIdentityService");
const { withPixelCaptureLock } = require("./pixelCaptureLock");
const { attachAnonymousJourneyToLead } = require("./attachAnonymousJourney");
const log = require("../core/logger")("PixelProcessor");

function mapCartItems(data = {}) {
  const raw =
    data.cartItems ||
    data.line_items ||
    (data.product ? [data.product] : []) ||
    [];
  if (!Array.isArray(raw)) return [];
  return raw.map((item, idx) => ({
    variant_id: String(item.variant_id || item.variantId || item.id || idx),
    quantity: Number(item.quantity || item.qty || 1) || 1,
    title: item.title || item.name || item.product_title || "Item",
    price: item.price || item.line_price || "",
    image: item.image || item.image_url || item.imageUrl || null,
  }));
}

function buildRecoverUrl(client, checkoutToken) {
  const storeHost = client.shopDomain
    ? String(client.shopDomain).replace(/^https?:\/\//, "").split("/")[0]
    : "";
  const token = checkoutToken ? String(checkoutToken).trim() : "";
  if (storeHost && token) return `https://${storeHost}/cart/recover/${token}`;
  return "";
}

async function resolveCommerceLeadFilter(clientId, { phone, email, checkoutToken }) {
  const token = checkoutToken ? String(checkoutToken).trim() : "";
  if (token) {
    const byToken = await AdLead.findOne({ clientId, checkoutToken: token })
      .select("_id phoneNumber")
      .lean();
    if (byToken) return { clientId, _id: byToken._id };
  }
  if (phone) return { clientId, phoneNumber: phone };
  if (email) return { clientId, email: String(email).toLowerCase() };
  return null;
}

async function upsertLeadFromCommerce(client, clientId, {
  phone,
  email,
  checkoutToken,
  checkoutUrl,
  cartItems,
  cartTotal,
  cartStatus,
  setAbandonTimestamps,
  extraSet = {},
}) {
  const filter = await resolveCommerceLeadFilter(clientId, { phone, email, checkoutToken });

  if (!filter) return null;

  const now = new Date();

  const queryForPurchased = phone
    ? { clientId, phoneNumber: phone }
    : email
      ? { clientId, email: String(email).toLowerCase() }
      : filter;

  const existing = await AdLead.findOne(queryForPurchased)
    .select("cartStatus isOrderPlaced cartAbandonedAt checkoutToken")
    .lean();
  const alreadyPurchased =
    existing && (existing.cartStatus === 'purchased' || existing.isOrderPlaced === true);
  if (alreadyPurchased && cartStatus !== 'purchased') {
    log.info(`[Pixel] Skip abandon upsert for purchased lead ${clientId}/${phone || email}`);
    return existing;
  }

  const { checkoutInitiatedCount: _ci, source: insertSource = "DeepPixel", ...restExtra } =
    extraSet || {};

  const $set = {
    lastInteraction: now,
    lastCartEventAt: now,
    source: insertSource,
    ...restExtra,
  };

  /** WS-3 C3: never reset `isOrderPlaced` to false on update — only set
   *  on new docs via `$setOnInsert`. Otherwise late pixel events
   *  re-open purchased carts for recovery. */
  if (cartStatus) $set.cartStatus = cartStatus;
  if (checkoutToken) $set.checkoutToken = checkoutToken;
  if (checkoutUrl) $set.checkoutUrl = checkoutUrl;
  if (email) $set.email = String(email).toLowerCase();
  if (phone) $set.phoneNumber = phone;
  if (cartTotal != null && cartTotal !== "") $set.cartValue = Number(cartTotal) || 0;

  if (cartItems?.length) {
    const total = Number(cartTotal) || 0;
    $set.cartSnapshot = {
      items: cartItems,
      updatedAt: now,
      totalPrice: total,
      total_price: total,
      checkoutUrl: checkoutUrl || "",
      checkoutToken: checkoutToken || "",
    };
  }

  const $setOnInsert = {
    clientId,
    createdAt: now,
    isOrderPlaced: false,
  };
  if (!phone && email) {
    $setOnInsert.phoneNumber = `unknown_email_${Date.now()}`;
  }

  /** WS-3 C3: `cartAbandonedAt` is the cron's timer anchor. Set it ONCE
   *  on insert — repeated pixel events must not slide the timer forward
   *  or msg #1 never lands within the 25-min default. */
  if (setAbandonTimestamps) {
    $setOnInsert.cartAbandonedAt = now;
    $setOnInsert.checkoutInitiatedAt = now;
  }

  const update = { $set, $setOnInsert };
  if (_ci) update.$inc = { checkoutInitiatedCount: 1 };

  return AdLead.findOneAndUpdate(filter, update, { upsert: true, new: true });
}

async function finalizeCaptureLead({
  clientId,
  lead,
  phone,
  checkoutToken,
  visitorId,
  sessionId,
  eventName,
  cartValue,
}) {
  if (!lead?._id) return lead;

  await attachAnonymousJourneyToLead({
    clientId,
    leadId: lead._id,
    visitorId,
    sessionId,
  }).catch((err) => {
    log.warn(`[Pixel] Journey stitch failed: ${err.message}`);
  });

  if (phone && lead._id) {
    const { ensureCartRecoveryAttempt } = require("./cartRecoveryAttemptService");
    await ensureCartRecoveryAttempt({
      clientId,
      leadId: lead._id,
      contactPhone: String(phone).replace(/[^0-9]/g, ""),
      checkoutToken,
      attemptTimestamp: Date.now(),
    }).catch((craErr) => {
      log.warn(`[Pixel] CartRecoveryAttempt ensure failed: ${craErr.message}`);
    });
  }

  if (global.io) {
    global.io.to(`client_${clientId}`).emit("lead_cart_update", {
      leadId: lead._id,
      phone: lead.phoneNumber,
      cartStatus: lead.cartStatus,
      cartValue: cartValue || lead.cartValue,
      event: eventName,
    });
  }

  return lead;
}

async function recordPixelEvent(clientId, leadId, eventName, payload) {
  try {
    const metadata = { ...(payload.metadata || {}) };
    if (payload.visitorId) metadata.visitorId = payload.visitorId;
    await PixelEvent.create({
      clientId,
      leadId: leadId || undefined,
      eventName,
      url: payload.url || "",
      sessionId: payload.sessionId,
      metadata,
      timestamp: payload.timestamp || new Date(),
      userAgent: payload.userAgent,
      ip: payload.ip,
    });
  } catch (err) {
    log.warn(`PixelEvent write failed: ${err.message}`);
  }
}

/**
 * Central pixel + web pixel event processor. Does NOT send recovery messages.
 */
async function processPixelEvent(clientId, eventData) {
  const {
    eventName,
    data = {},
    customer,
    timestamp,
    sessionId,
    url,
    userAgent,
    ip,
    shopifyClientId,
    visitorId,
  } = eventData;

  const client = await require("../../models/Client").findOne({ clientId }).lean();
  if (!client) return { error: "Client not found" };

  const meta = { ...data, sessionId, url, source: data.source || "theme_pixel" };
  const email =
    customer?.email || data.email || data.checkout?.email || meta.email || null;
  const rawPhone =
    customer?.phone || data.phone || data.checkout?.phone || meta.phone || null;
  let phone = rawPhone ? normalizePhoneWithCountry(rawPhone, client) : "";
  if (!phone && meta.phone) phone = normalizePhoneWithCountry(meta.phone, client);
  const checkoutToken = data.checkoutToken || data.token || data.checkout_token || "";

  await stitchVisitorIdentity(clientId, client, {
    visitorId: visitorId || data.visitorId,
    shopifyClientId: shopifyClientId || data.shopifyClientId,
    checkoutToken,
    phone,
    email,
  });

  const checkoutUrl =
    data.checkoutUrl || data.checkout_url || buildRecoverUrl(client, checkoutToken);

  const captureMode = data.captureMode || meta.captureMode || "";
  const isLiveCapture =
    captureMode === "live" ||
    captureMode === "live_ui_extension" ||
    captureMode === "live_theme";

  const hasCartContextFlag = Boolean(data.hasCartContext || meta.hasCartContext);

  const dedupeKey = checkoutToken || phone || email || visitorId || sessionId;

  // --- Checkout contact (Web Pixel + legacy aliases + live UI extension) ---
  if (
    eventName === "checkout_contact_identified" ||
    eventName === "checkout_contact_info_submitted"
  ) {
    return withPixelCaptureLock(clientId, dedupeKey, async () => {
      const cartItems = mapCartItems(data);
      const cartStatus = isLiveCapture ? "active" : "abandoned";
      const extraSet = {
        source:
          data.source === "shopify_web_pixel" || data.source === "shopify_web_pixel_extension"
            ? "Web Pixel"
            : isLiveCapture
              ? "DeepPixel (Live)"
              : "DeepPixel",
        checkoutInitiatedCount: !isLiveCapture,
      };
      if (isLiveCapture) {
        extraSet.contactCapturedAt = new Date();
      }

      const lead = await upsertLeadFromCommerce(client, clientId, {
        phone,
        email,
        checkoutToken,
        checkoutUrl,
        cartItems,
        cartTotal: data.cartTotal || data.total_price,
        cartStatus,
        setAbandonTimestamps: true,
        extraSet,
      });

      await recordPixelEvent(clientId, lead?._id, "checkout_contact_identified", {
        url,
        sessionId,
        visitorId: visitorId || data.visitorId,
        metadata: { ...meta, source: data.source || "shopify_web_pixel", captureMode },
        timestamp,
        userAgent,
        ip,
      });

      await finalizeCaptureLead({
        clientId,
        lead,
        phone,
        checkoutToken,
        visitorId: visitorId || data.visitorId,
        sessionId,
        eventName: "checkout_contact_identified",
        cartValue: data.cartTotal || data.total_price,
      });

      return { success: true, leadId: lead?._id, status: "checkout_contact_captured" };
    });
  }

  // --- Contact identified (storefront + third-party forms) ---
  if (eventName === "contact_identified") {
    return withPixelCaptureLock(clientId, dedupeKey, async () => {
      const qPhone = data.phone ? normalizePhoneWithCountry(data.phone, client) : phone;
      const qEmail = data.email || email;

      const existingForContext = qPhone
        ? await AdLead.findOne({ clientId, phoneNumber: qPhone })
            .select("addToCartCount cartSnapshot cartStatus")
            .lean()
        : null;

      const hasCartContext =
        Boolean(checkoutToken) ||
        hasCartContextFlag ||
        (existingForContext?.addToCartCount || 0) > 0 ||
        (existingForContext?.cartSnapshot?.items?.length || 0) > 0 ||
        mapCartItems(data).length > 0;

      let idLead = null;

      if (hasCartContext && (qPhone || qEmail)) {
        const cartItems = mapCartItems(data);
        const cartStatus = isLiveCapture ? "active" : "abandoned";
        const extraSet = {
          source: isLiveCapture ? "DeepPixel (Live)" : "DeepPixel (Identified)",
        };
        if (isLiveCapture) {
          extraSet.contactCapturedAt = new Date();
        }

        idLead = await upsertLeadFromCommerce(client, clientId, {
          phone: qPhone,
          email: qEmail,
          checkoutToken,
          checkoutUrl,
          cartItems,
          cartTotal: data.cartTotal || data.total_price,
          cartStatus,
          setAbandonTimestamps: true,
          extraSet,
        });

        await finalizeCaptureLead({
          clientId,
          lead: idLead,
          phone: qPhone,
          checkoutToken,
          visitorId: visitorId || data.visitorId,
          sessionId,
          eventName: "contact_identified",
          cartValue: data.cartTotal || data.total_price,
        });
      } else if (qPhone) {
        idLead = await upsertLeadFromCommerce(client, clientId, {
          phone: qPhone,
          email: qEmail,
          extraSet: { source: "DeepPixel (Identified)" },
        });
      } else if (qEmail) {
        idLead = await upsertLeadFromCommerce(client, clientId, {
          email: qEmail,
          extraSet: { source: "DeepPixel (Identified)" },
        });
      }

      if (idLead && !hasCartContext) {
        idLead.activityLog = idLead.activityLog || [];
        idLead.activityLog.push({
          action: "pixel_contact_identified",
          details: "Source: pixel_capture",
          timestamp: new Date(),
        });
        await idLead.save();
      }

      await recordPixelEvent(clientId, idLead?._id, "contact_identified", {
        url,
        sessionId,
        visitorId: visitorId || data.visitorId,
        metadata: meta,
        timestamp,
        userAgent,
        ip,
      });

      return { success: true, leadId: idLead?._id };
    });
  }

  const hasIdentity = !!(email || phone) || eventName === "contact_identified";

  if (hasIdentity || ["checkout_started", "product_added_to_cart", "checkout_completed", "page_view"].includes(eventName)) {
    let lead = null;
    if (phone || email) {
      lead = await AdLead.findOne(
        phone ? { clientId, phoneNumber: phone } : { clientId, email: String(email).toLowerCase() }
      );
      if (!lead && (phone || email)) {
        lead = await upsertLeadFromCommerce(client, clientId, {
          phone,
          email,
          extraSet: { source: "DeepPixel (Identified)" },
        });
      }
    }

    if (lead) {
      const amount =
        data?.checkout?.totalPrice?.amount || data?.total_price || data?.cartTotal || 0;
      lead.commerceEvents = lead.commerceEvents || [];
      lead.commerceEvents.push({
        event: eventName,
        amount: parseFloat(amount) || 0,
        currency: data?.checkout?.totalPrice?.currencyCode || data?.currency || "INR",
        timestamp: timestamp || new Date(),
        metadata: meta,
      });

      if (eventName === "product_added_to_cart") {
        lead.addToCartCount = (lead.addToCartCount || 0) + 1;
        lead.cartStatus = "abandoned";
        lead.isOrderPlaced = false;
        lead.lastCartEventAt = new Date();
      }

      if (eventName === "checkout_started") {
        lead.checkoutInitiatedCount = (lead.checkoutInitiatedCount || 0) + 1;
        lead.cartStatus = "abandoned";
        lead.isOrderPlaced = false;
        lead.lastCartEventAt = new Date();
        if (!lead.cartAbandonedAt) lead.cartAbandonedAt = new Date();
        if (!lead.checkoutInitiatedAt) lead.checkoutInitiatedAt = new Date();
        if (checkoutToken) lead.checkoutToken = checkoutToken;
        if (checkoutUrl) lead.checkoutUrl = checkoutUrl;
      }

      if (eventName === "checkout_completed") {
        lead.totalSpent = (lead.totalSpent || 0) + (parseFloat(amount) || 0);
        lead.ordersCount = (lead.ordersCount || 0) + 1;
        lead.isOrderPlaced = true;
        lead.cartStatus = "purchased";
      }

      await lead.save();

      const mappedEvent = eventName === "product_added_to_cart" ? "add_to_cart" : eventName;
      await recordPixelEvent(clientId, lead._id, mappedEvent, {
        url,
        sessionId,
        visitorId: visitorId || data.visitorId,
        metadata: meta,
        timestamp,
        userAgent,
        ip,
      });

      if (global.io) {
        const room = `client_${clientId}`;
        if (eventName === "product_added_to_cart" || eventName === "checkout_started") {
          global.io.to(room).emit("lead_cart_update", {
            leadId: lead._id,
            phone: lead.phoneNumber,
            cartStatus: lead.cartStatus,
            event: mappedEvent,
          });
        }
        if (eventName === "checkout_completed") {
          global.io.to(room).emit("lead_purchased", {
            leadId: lead._id,
            phone: lead.phoneNumber,
            cartStatus: "purchased",
          });
        }
      }
      return { success: true, leadId: lead._id };
    }
  }

  await recordPixelEvent(clientId, null, eventName, {
    url,
    sessionId,
    visitorId: visitorId || data.visitorId,
    metadata: meta,
    timestamp,
    userAgent,
    ip,
  });
  return { success: true, status: "anonymous_logged" };
}

function generateWebPixelScript(clientId, baseUrl) {
  const endpoint = `${baseUrl}/api/shopify-pixel/pixel/${clientId}/event`;
  return `
(function () {
  var ENDPOINT = "${endpoint}";
  var CLIENT_ID = "${clientId}";

  function send(eventName, data) {
    var payload = {
      eventName: eventName,
      metadata: Object.assign({}, data || {}, { source: "shopify_web_pixel" }),
      timestamp: new Date().toISOString()
    };
    if (data && data.shopifyClientId) payload.shopifyClientId = data.shopifyClientId;
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(function () {});
  }

  analytics.subscribe("checkout_contact_info_submitted", function (event) {
    var checkout = event.data && event.data.checkout;
    if (!checkout) return;
    var lineItems = (checkout.lineItems || []).map(function (li) {
      var v = li.variant || li.merchandise || {};
      var p = v.product || {};
      return {
        title: p.title || v.title || "Item",
        variantId: v.id,
        productId: p.id,
        quantity: li.quantity || 1,
        price: v.price && v.price.amount,
        image: (v.image && v.image.src) || (p.featuredImage && p.featuredImage.url)
      };
    });
    send("checkout_contact_identified", {
      email: checkout.email,
      phone: checkout.phone,
      checkoutToken: checkout.token,
      checkoutUrl: checkout.webUrl,
      cartTotal: checkout.totalPrice && checkout.totalPrice.amount,
      cartItems: lineItems,
      shopifyClientId: event.clientId
    });
  });

  analytics.subscribe("checkout_started", function (event) {
    var c = event.data && event.data.checkout;
    if (!c) return;
    send("checkout_started", {
      checkoutToken: c.token,
      cartTotal: c.totalPrice && c.totalPrice.amount,
      shopifyClientId: event.clientId
    });
  });

  analytics.subscribe("checkout_completed", function (event) {
    var c = event.data && event.data.checkout;
    if (!c) return;
    send("checkout_completed", {
      checkoutToken: c.token,
      orderId: c.order && c.order.id,
      email: c.email,
      phone: c.phone,
      cartTotal: c.totalPrice && c.totalPrice.amount,
      shopifyClientId: event.clientId
    });
  });

  analytics.subscribe("product_added_to_cart", function (event) {
    var line = event.data && event.data.cartLine;
    if (!line) return;
    var merch = line.merchandise || {};
    var prod = merch.product || {};
    send("product_added_to_cart", {
      product: {
        title: prod.title,
        id: prod.id,
        price: merch.price && merch.price.amount
      },
      shopifyClientId: event.clientId
    });
  });

  analytics.subscribe("page_viewed", function (event) {
    send("page_view", {
      url: event.context && event.context.document && event.context.document.location && event.context.document.location.href,
      shopifyClientId: event.clientId
    });
  });
})();
`.trim();
}

module.exports = {
  processPixelEvent,
  generateWebPixelScript,
};
