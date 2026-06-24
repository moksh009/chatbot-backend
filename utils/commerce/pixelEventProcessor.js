"use strict";

const AdLead = require("../../models/AdLead");
const PixelEvent = require("../../models/PixelEvent");
const { normalizePhoneWithCountry } = require("../core/helpers");
const { normalizeIndianPhone, indianPhoneLookupVariants, isValidIndianMobileInput } = require("../core/normalizeIndianPhone");
const { stitchVisitorIdentity } = require("./visitorIdentityService");
const { withPixelCaptureLock } = require("./pixelCaptureLock");
const { upsertAbandonedCartLead, resolveLeadQueryForUpsert } = require("./upsertAbandonedCartLead");
const { attachAnonymousJourneyToLead } = require("./attachAnonymousJourney");
const log = require("../core/logger")("PixelProcessor");
const { touchActiveVisitor } = require("./pixelActiveVisitors");
const { rollupProductEvent } = require("./productInsightsRollup");
const { deriveProductViewFromPageEvent } = require("./productViewDerivation");
const { enrichPixelMetadata } = require("./pixelEventUrlUtils");
const { extractUtmFields } = require("./pixelUtmUtils");
const { emitCartContactCaptured } = require("./pixelSocketEmit");
const { emitPixelActivity } = require("./pixelActivityEmit");

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

const { buildLeadRecoveryBaseUrl } = require("./buildRecoveryUrl");

async function resolveCommerceLeadFilter(clientId, { phone, email, checkoutToken }) {
  const phoneE164 = phone ? normalizeIndianPhone(phone) : null;
  const phoneLookup = phoneE164 ? indianPhoneLookupVariants(phoneE164) : [];
  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
  const token = checkoutToken ? String(checkoutToken).trim() : "";

  if (!phoneE164 && !normalizedEmail && !token) return null;

  const { query } = await resolveLeadQueryForUpsert(clientId, {
    phoneE164,
    phoneLookup,
    email: normalizedEmail,
    checkoutToken: token,
  });
  return query;
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
    ? { clientId, phoneNumber: { $in: indianPhoneLookupVariants(phone) } }
    : email
      ? { clientId, email: String(email).toLowerCase() }
      : filter;

  const existing = await AdLead.findOne(queryForPurchased)
    .select("cartStatus isOrderPlaced cartAbandonedAt checkoutToken source")
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
    ...restExtra,
  };
  // source is insert-only via $setOnInsert — preserves shopify_native from webhooks

  /** WS-3 C3: never reset `isOrderPlaced` to false on update — only set
   *  on new docs via `$setOnInsert`. Otherwise late pixel events
   *  re-open purchased carts for recovery. */
  if (cartStatus) $set.cartStatus = cartStatus;
  if (checkoutToken) $set.checkoutToken = checkoutToken;
  if (checkoutUrl) $set.checkoutUrl = checkoutUrl;
  if (email) $set.email = String(email).toLowerCase();
  if (phone) {
    const e164 = normalizeIndianPhone(phone);
    if (e164) $set.phoneNumber = e164;
  }
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
    source: insertSource,
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
    checkoutToken,
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
    emitCartContactCaptured(clientId, {
      leadId: String(lead._id),
      phone: lead.phoneNumber,
      cartValue: cartValue || lead.cartValue || 0,
      cartStatus: lead.cartStatus,
      event: eventName,
    });
  }

  return lead;
}

async function recordPixelEvent(clientId, leadId, eventName, payload) {
  try {
    const { url, metadata } = enrichPixelMetadata(payload, {});
    if (payload.visitorId) metadata.visitorId = payload.visitorId;
    if (payload.shopifyClientId) metadata.shopifyClientId = payload.shopifyClientId;
    const doc = await PixelEvent.create({
      clientId,
      leadId: leadId || undefined,
      eventName,
      url,
      sessionId: payload.sessionId,
      metadata,
      timestamp: payload.timestamp || new Date(),
      userAgent: payload.userAgent,
      ip: payload.ip,
    });
    const rollupEvents = ["product_view", "product_added_to_cart", "add_to_cart", "page_view"];
    if (rollupEvents.includes(eventName)) {
      await rollupProductEvent(
        clientId,
        eventName,
        { ...metadata, product: metadata.product, url: doc.url },
        { timestamp: doc.timestamp, url: doc.url }
      );
    }
    let derivedDoc = null;
    if (eventName === "page_view") {
      derivedDoc = await deriveProductViewFromPageEvent(clientId, doc, {
        ...payload,
        url,
        metadata,
        shopifyClientId: payload.shopifyClientId || metadata.shopifyClientId,
      });
    }
    emitPixelActivity(clientId, { eventName });
    if (derivedDoc) emitPixelActivity(clientId, { eventName: "product_view", derived: true });
    return doc;
  } catch (err) {
    log.warn(`PixelEvent write failed: ${err.message}`);
    return null;
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

  if (!client.shopifyThemePixelInstalledAt) {
    await require("../../models/Client").updateOne(
      { clientId },
      { $set: { shopifyThemePixelInstalledAt: new Date() } }
    );
  }

  const enriched = enrichPixelMetadata({ url, metadata: data, pathname: data.pathname }, {});
  const resolvedUrl = enriched.url;
  const checkoutToken = data.checkoutToken || data.token || data.checkout_token || "";
  const meta = {
    ...data,
    ...enriched.metadata,
    sessionId,
    url: resolvedUrl,
    source: data.source || "theme_pixel",
  };
  if (shopifyClientId || data.shopifyClientId) {
    meta.shopifyClientId = shopifyClientId || data.shopifyClientId;
  }
  if (checkoutToken) meta.checkoutToken = checkoutToken;
  const utmFields = extractUtmFields({ ...data, url });
  const email =
    customer?.email || data.email || data.checkout?.email || meta.email || null;
  const rawPhone =
    customer?.phone || data.phone || data.checkout?.phone || meta.phone || null;
  let phone = rawPhone ? normalizeIndianPhone(rawPhone) : null;
  if (!phone && rawPhone) {
    const digits = normalizePhoneWithCountry(rawPhone, client);
    phone = digits ? normalizeIndianPhone(digits) : null;
  }

  await stitchVisitorIdentity(clientId, client, {
    visitorId: visitorId || data.visitorId,
    shopifyClientId: shopifyClientId || data.shopifyClientId,
    checkoutToken,
    phone,
    email,
  });

  const checkoutUrl =
    data.checkoutUrl || data.checkout_url || buildLeadRecoveryBaseUrl(client, { checkoutToken });

  const captureMode = data.captureMode || meta.captureMode || "";
  const isLiveCapture =
    captureMode === "live" ||
    captureMode === "live_ui_extension" ||
    captureMode === "live_theme";

  const hasCartContextFlag = Boolean(data.hasCartContext || meta.hasCartContext);

  const dedupeKey = checkoutToken || phone || email || visitorId || sessionId;

  const trackableEvents = [
    "page_view",
    "product_view",
    "product_added_to_cart",
    "checkout_started",
    "contact_identified",
    "checkout_contact_identified",
    "exit_intent",
  ];
  if (trackableEvents.includes(eventName)) {
    await touchActiveVisitor(clientId, sessionId || visitorId || dedupeKey);
  }

  // --- Exit intent (checkout extension) — priority queue signal (NEW-1) ---
  if (eventName === 'exit_intent') {
    return withPixelCaptureLock(clientId, dedupeKey, async () => {
      const filter = await resolveCommerceLeadFilter(clientId, { phone, email, checkoutToken });
      if (!filter) {
        return { success: true, status: 'exit_intent_no_lead' };
      }
      await AdLead.updateOne(filter, { $set: { exitIntentAt: new Date() } });
      const leadDoc = filter._id
        ? await AdLead.findById(filter._id).select('_id').lean()
        : await AdLead.findOne(filter).select('_id').lean();
      await recordPixelEvent(clientId, leadDoc?._id, 'exit_intent', {
        url: resolvedUrl,
        sessionId,
        visitorId: visitorId || data.visitorId,
        shopifyClientId: shopifyClientId || data.shopifyClientId,
        metadata: { ...meta, source: data.source || 'shopify_web_pixel' },
        timestamp,
        userAgent,
        ip,
      });
      return { success: true, status: 'exit_intent_recorded' };
    });
  }

  // --- Checkout contact (Web Pixel + legacy aliases + live UI extension) ---
  if (
    eventName === "checkout_contact_identified" ||
    eventName === "checkout_contact_info_submitted"
  ) {
    if (!phone && !email) {
      return { success: true, skipped: true, status: "no_contact" };
    }
    if (isLiveCapture && !email) {
      const phoneCandidate = rawPhone || data.phone || meta.phone || null;
      if (!isValidIndianMobileInput(phoneCandidate)) {
        return { success: true, skipped: true, status: "invalid_phone" };
      }
    }

    return withPixelCaptureLock(clientId, dedupeKey, async () => {
      const cartItems = mapCartItems(data);
      const cartStatus = isLiveCapture ? "active" : "abandoned";
      const captureSource =
        data.source === "shopify_web_pixel" || data.source === "shopify_web_pixel_extension"
          ? "Web Pixel"
          : isLiveCapture
            ? "DeepPixel (Live)"
            : "DeepPixel";

      const result = await upsertAbandonedCartLead(client, {
        clientId,
        phone: phone || rawPhone,
        email,
        checkoutToken,
        checkoutUrl,
        cartItems,
        cartTotal: data.cartTotal || data.total_price,
        cartStatus,
        source: captureSource,
        contactCapturedAt: isLiveCapture ? new Date() : undefined,
        logActivity: false,
        visitorId: visitorId || data.visitorId,
        sessionId,
        ...utmFields,
      });

      if (result.skipped && result.reason === 'debounced') {
        return { success: true, skipped: true, status: "debounced" };
      }

      const lead = result.lead;

      await recordPixelEvent(clientId, lead?._id, "checkout_contact_identified", {
        url: resolvedUrl,
        sessionId,
        visitorId: visitorId || data.visitorId,
        metadata: { ...meta, source: data.source || "shopify_web_pixel", captureMode },
        timestamp,
        userAgent,
        ip,
      });

      return { success: true, leadId: lead?._id, status: "checkout_contact_captured" };
    });
  }

  // --- Contact identified (storefront + third-party forms) ---
  if (eventName === "contact_identified") {
    return withPixelCaptureLock(clientId, dedupeKey, async () => {
      let qPhone = phone;
      if (data.phone) {
        qPhone =
          normalizeIndianPhone(data.phone) ||
          normalizeIndianPhone(normalizePhoneWithCountry(data.phone, client));
      }
      const qEmail = data.email || email;

      const existingForContext = qPhone
        ? await AdLead.findOne({ clientId, phoneNumber: { $in: indianPhoneLookupVariants(qPhone) } })
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
          ...utmFields,
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
          extraSet: { source: "DeepPixel (Identified)", ...utmFields },
        });
      } else if (qEmail) {
        idLead = await upsertLeadFromCommerce(client, clientId, {
          email: qEmail,
          extraSet: { source: "DeepPixel (Identified)", ...utmFields },
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
        url: resolvedUrl,
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

  if (eventName === 'checkout_completed') {
    return withPixelCaptureLock(clientId, dedupeKey, async () => {
      const amount =
        parseFloat(
          data?.checkout?.totalPrice?.amount || data?.total_price || data?.cartTotal || 0
        ) || 0;
      const orderId = data.orderId || data.order?.id || '';
      const orderPayload = {
        id: orderId || `pixel_${checkoutToken || Date.now()}`,
        name: orderId ? `#${orderId}` : undefined,
        created_at: timestamp || new Date(),
        total_price: String(amount),
        phone: rawPhone || phone,
        email,
        checkout_token: checkoutToken,
        cart_token: data.cart_token || '',
        financial_status: 'paid',
        currency: data?.checkout?.totalPrice?.currencyCode || data?.currency || 'INR',
      };

      const { handleOrderAtomic } = require('../shopify/handleOrderAtomic');
      const cleanDigits = phone ? normalizePhoneWithCountry(phone, client) : '';
      let atomic = null;
      try {
        atomic = await handleOrderAtomic(client, orderPayload, cleanDigits || '');
      } catch (err) {
        log.warn(`[Pixel] checkout_completed atomic failed: ${err.message}`);
      }

      let lead = atomic?.lead || null;
      if (!lead && (checkoutToken || phone || email)) {
        const { findRecoveryLead } = require('../shopify/handleOrderAtomic');
        lead = await findRecoveryLead(clientId, orderPayload, cleanDigits || '');
        if (lead && !lead.isOrderPlaced) {
          lead.isOrderPlaced = true;
          lead.cartStatus = atomic?.recoveryMatched ? 'recovered' : 'purchased';
          lead.totalSpent = (lead.totalSpent || 0) + amount;
          lead.ordersCount = (lead.ordersCount || 0) + 1;
          lead.lastPurchaseDate = new Date();
          await lead.save();
        }
      }

      await recordPixelEvent(clientId, lead?._id, 'checkout_completed', {
        url: resolvedUrl,
        sessionId,
        visitorId: visitorId || data.visitorId,
        metadata: { ...meta, source: data.source || 'shopify_web_pixel', orderId },
        timestamp,
        userAgent,
        ip,
      });

      if (global.io && lead) {
        const room = `client_${clientId}`;
        global.io.to(room).emit('lead_purchased', {
          leadId: lead._id,
          phone: lead.phoneNumber,
          cartStatus: lead.cartStatus,
        });
        if (atomic?.recoveryMatched) {
          const { emitCartRecovered } = require('./pixelSocketEmit');
          emitCartRecovered(clientId, {
            leadId: String(lead._id),
            orderId: String(orderId || orderPayload.id),
            orderValue: amount,
            recoveredViaWhatsapp: lead.recoveredViaWhatsApp === true,
            revenue: amount,
          });
        }
      }

      return {
        success: true,
        leadId: lead?._id,
        recovered: !!atomic?.recoveryMatched,
        status: atomic?.duplicate ? 'duplicate' : 'processed',
      };
    });
  }

  const hasIdentity = !!(email || phone) || eventName === "contact_identified";

  if (hasIdentity || ["checkout_started", "product_added_to_cart", "checkout_completed", "page_view", "product_view", "search"].includes(eventName)) {
    let lead = null;
    if (phone || email) {
      lead = await AdLead.findOne(
        phone
          ? { clientId, phoneNumber: { $in: indianPhoneLookupVariants(phone) } }
          : { clientId, email: String(email).toLowerCase() }
      );
      if (!lead && (phone || email)) {
        lead = await upsertLeadFromCommerce(client, clientId, {
          phone,
          email,
          extraSet: { source: "DeepPixel (Identified)", ...utmFields },
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
        url: resolvedUrl,
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
    url: resolvedUrl,
    sessionId,
    visitorId: visitorId || data.visitorId,
    shopifyClientId: shopifyClientId || data.shopifyClientId,
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

  function pageLocation(event) {
    var doc = event && event.context && event.context.document;
    var loc = doc && doc.location;
    if (!loc && event && event.context && event.context.window) loc = event.context.window.location;
    if (loc) return { href: loc.href || "", pathname: loc.pathname || "" };
    return { href: "", pathname: "" };
  }

  var SESSION_ID = "";
  try {
    if (typeof browser !== "undefined" && browser.sessionStorage) {
      SESSION_ID = browser.sessionStorage.getItem("te_px_sid") || "";
      if (!SESSION_ID) {
        SESSION_ID = "sess_" + Math.random().toString(36).slice(2, 11);
        browser.sessionStorage.setItem("te_px_sid", SESSION_ID);
      }
    }
  } catch (e) {}

  function send(eventName, data) {
    var extra = data || {};
    var loc = pageLocation(extra._evt);
    var href = (extra.url) || loc.href || loc.pathname || "";
    var pathname = extra.pathname || loc.pathname || "";
    var meta = Object.assign({}, extra);
    delete meta._evt;
    delete meta.url;
    delete meta.pathname;
    meta.source = "shopify_web_pixel";
    if (href) meta.url = href;
    if (pathname) meta.pathname = pathname;
    var payload = {
      eventName: eventName,
      url: href || undefined,
      sessionId: SESSION_ID || undefined,
      metadata: meta,
      timestamp: new Date().toISOString()
    };
    if (extra.shopifyClientId) payload.shopifyClientId = extra.shopifyClientId;
    if (extra.product) payload.metadata.product = extra.product;
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
        productId: prod.id,
        variantId: merch.id,
        title: prod.title || merch.title,
        handle: prod.handle,
        price: merch.price && merch.price.amount,
        currency: merch.price && merch.price.currencyCode,
        image: (merch.image && merch.image.src) || (prod.featuredImage && prod.featuredImage.url),
        sku: merch.sku,
        quantity: line.quantity || 1
      },
      shopifyClientId: event.clientId
    });
  });

  analytics.subscribe("product_viewed", function (event) {
    var v = (event.data && event.data.productVariant) || {};
    var p = v.product || {};
    var loc = pageLocation(event);
    send("product_view", {
      url: loc.href || loc.pathname,
      pathname: loc.pathname,
      product: {
        productId: p.id,
        variantId: v.id,
        title: p.title || v.title,
        handle: p.handle,
        price: v.price && v.price.amount,
        currency: v.price && v.price.currencyCode,
        image: (v.image && v.image.src) || (p.featuredImage && p.featuredImage.url),
        sku: v.sku
      },
      shopifyClientId: event.clientId,
      _evt: event
    });
  });

  analytics.subscribe("search_submitted", function (event) {
    var search = event.data && event.data.searchResult;
    send("search", {
      url: pageUrl(event),
      query: (search && search.query) || (event.data && event.data.searchQuery) || "",
      shopifyClientId: event.clientId
    });
  });

  analytics.subscribe("page_viewed", function (event) {
    var loc = pageLocation(event);
    var href = loc.href || loc.pathname;
    send("page_view", {
      url: href,
      pathname: loc.pathname,
      shopifyClientId: event.clientId,
      _evt: event
    });
    if (href && href.indexOf("/products/") !== -1) {
      var handle = null;
      try {
        var path = loc.pathname || new URL(href, "https://shop.local").pathname;
        var match = path.match(/\\/products\\/([^/?#]+)/);
        if (match && match[1]) handle = decodeURIComponent(match[1]);
      } catch (e) {}
      if (handle) {
        send("product_view", {
          url: href,
          pathname: loc.pathname,
          product: { handle: handle },
          derivedFrom: "page_viewed",
          shopifyClientId: event.clientId,
          _evt: event
        });
      }
    }
  });
})();
`.trim();
}

module.exports = {
  processPixelEvent,
  generateWebPixelScript,
};
