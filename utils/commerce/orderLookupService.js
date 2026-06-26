"use strict";

/**
 * Single source of truth for "latest order for this WhatsApp number".
 * Tries Shopify Admin REST (when store is connected), then local Order documents
 * with strict phone matching (no loose regex that can collide across customers).
 */

const Order = require("../../models/Order");
const { normalizePhone } = require('../core/helpers');
const { sanitizePhoneForStorage, phoneStorageLookupVariants } = require('../core/phoneE164Policy');
const { withShopifyRetry, withShopifyGraphQL } = require('../shopify/shopifyHelper');
const { withTimeout } = require('../core/asyncTimeout');
const log = require('../core/logger')("OrderLookup");

function phoneSearchVariants(raw) {
  const e164 = sanitizePhoneForStorage(raw);
  const legacy = [
    String(raw || "").trim(),
    String(raw || "").replace(/\D/g, ""),
    normalizePhone(raw),
    normalizePhone(raw) ? `+${normalizePhone(raw)}` : "",
  ];
  return uniqueStrings([...phoneStorageLookupVariants(raw), ...legacy].filter(Boolean));
}

function uniqueStrings(arr) {
  return [...new Set(arr)];
}

/**
 * Local Mongo orders — match only explicit phone strings (normalized + raw).
 */
async function findLocalOrder(clientId, phone) {
  const variants = uniqueStrings(phoneSearchVariants(phone));
  if (!variants.length) return null;

  const or = [];
  for (const v of variants) {
    or.push({ customerPhone: v });
    or.push({ phone: v });
  }

  const q = {
    clientId,
    $or: or,
  };

  return await Order.findOne(q).sort({ createdAt: -1 }).lean();
}

async function fetchFirstProductImage(shopify, productId) {
  if (!productId || !shopify) return "";
  try {
    const pr = await shopify.get(`/products/${productId}.json`);
    const product = pr.data?.product;
    const imgs = Array.isArray(product?.images) ? product.images : [];
    return (imgs[0] && imgs[0].src) || (product?.image && product.image.src) || "";
  } catch (e) {
    log.warn("[OrderLookup] product image fetch skipped", { message: e.message });
    return "";
  }
}

/**
 * @param {object} params
 * @param {object} params.client - Client mongoose doc or lean
 * @param {string} params.phone - WhatsApp E.164 / raw
 * @returns {Promise<object>}
 */
async function resolveLatestOrderContext({ client, phone }) {
  const baseMeta = {
    shopify_order_found: "false",
    last_order_lookup_found: "false",
    first_product_title: "",
    first_product_image: "",
  };

  const notFoundMsg =
    "We could not find an order linked to *this WhatsApp number* yet.\n\n" +
    "If you ordered with a different number, share your *order ID* (e.g. #1042) and we will look it up.";

  /** @type {null | { order: object; firstProductImage: string }} */
  let shopifyPayload = null;
  try {
    shopifyPayload = await withTimeout(
      withShopifyRetry(client.clientId, async (shopify) => {
      const variants = uniqueStrings(phoneSearchVariants(phone));
      const formats = variants.length
        ? variants
        : [String(phone || "").replace(/\D/g, "")];

      let order = null;
      for (const ph of formats) {
        if (!ph) continue;
        try {
          const res = await shopify.get(
            `/orders.json?status=any&limit=1&phone=${encodeURIComponent(ph)}`
          );
          if (res.data.orders?.length > 0) {
            order = res.data.orders[0];
            break;
          }
        } catch (_) {
          /* try next format */
        }
      }
      if (!order) return null;
      const li0 = (Array.isArray(order.line_items) ? order.line_items : [])[0];
      const firstProductImage = li0?.product_id
        ? await fetchFirstProductImage(shopify, li0.product_id)
        : "";
      return { order, firstProductImage };
    }),
      5000,
      'OrderLookupShopify'
    );
  } catch (e) {
    log.info("[OrderLookup] Shopify unavailable — falling back to local DB", {
      clientId: client.clientId,
      message: e.message,
    });
  }

  const shopifyOrder = shopifyPayload?.order || null;
  const preImage = shopifyPayload?.firstProductImage || "";

  if (shopifyOrder) {
    const fulfillStatus =
      shopifyOrder.fulfillment_status || shopifyOrder.financial_status || "Confirmed";
    const lineItems = Array.isArray(shopifyOrder.line_items)
      ? shopifyOrder.line_items
      : [];
    const items = lineItems.map((i) => `• ${i.title} × ${i.quantity}`).join("\n");
    const firstItemTitle = String(lineItems[0]?.title || "").trim();
    const tracking = shopifyOrder.fulfillments?.[0]?.tracking_url;
    const payGw = (shopifyOrder.payment_gateway_names || [])
      .join(", ")
      .trim();

    const firstProductImage = preImage;

    const statusEmoji = {
      pending: "⏳",
      confirmed: "✅",
      processing: "🔄",
      shipped: "🚚",
      delivered: "🎉",
      cancelled: "❌",
      refunded: "💰",
    };
    const emoji = statusEmoji[String(fulfillStatus).toLowerCase()] || "📦";
    let msg = `${emoji} *Order #${shopifyOrder.order_number}*\n\n`;
    msg += `Status: *${String(fulfillStatus).toUpperCase()}*\n`;
    msg += `Items:\n${items || "N/A"}\n`;
    msg += `Total: *${shopifyOrder.currency} ${parseFloat(shopifyOrder.total_price || 0).toFixed(2)}*`;
    if (tracking) msg += `\n\n📍 Track: ${tracking}`;
    if (shopifyOrder.order_status_url) msg += `\n🔗 Details: ${shopifyOrder.order_status_url}`;

    const orderData = {
      orderNumber: shopifyOrder.order_number,
      orderId: shopifyOrder.id,
      status: fulfillStatus,
      totalPrice: shopifyOrder.total_price,
      trackingUrl: tracking || null,
      currency: shopifyOrder.currency,
      itemsSummary: items || "",
      payment_method: payGw,
    };

    const fsRaw = String(shopifyOrder.fulfillment_status || "").toLowerCase();
    const hasFulfillment =
      Array.isArray(shopifyOrder.fulfillments) && shopifyOrder.fulfillments.length > 0;
    const isShippedLike =
      fsRaw === "fulfilled" ||
      fsRaw === "partial" ||
      fsRaw === "shipped" ||
      (hasFulfillment && fsRaw !== "restocked");

    const mergedMeta = {
      ...baseMeta,
      lastOrder: orderData,
      shopify_order_found: "true",
      last_order_lookup_found: "true",
      shopify_order_id: shopifyOrder.id,
      order_number: shopifyOrder.name
        ? String(shopifyOrder.name)
        : `#${shopifyOrder.order_number}`,
      order_status: fulfillStatus,
      payment_method: payGw,
      is_shipped: isShippedLike ? "true" : "false",
      first_product_title: firstItemTitle,
      first_product_image: firstProductImage,
      last_order_items_count: String(lineItems.length || 0),
    };

    return {
      found: true,
      source: "shopify",
      userMessage: msg,
      orderData,
      mergedMeta,
    };
  }

  const local = await findLocalOrder(client.clientId, phone);
  if (!local) {
    return {
      found: false,
      source: null,
      userMessage: notFoundMsg,
      orderData: null,
      mergedMeta: baseMeta,
    };
  }

  const label = local.orderNumber || local.orderId || "your order";
  const amt = local.totalPrice != null ? local.totalPrice : local.amount;
  const statusMsg =
    `📦 *Order ${label}*\n` +
    `Status: *${local.status || local.financialStatus || "Processing"}*\n` +
    `Total: ₹${amt != null ? amt : "—"}\n` +
    `Placed: ${new Date(local.createdAt).toLocaleDateString("en-IN")}\n` +
    (local.trackingUrl ? `🚚 Tracking: ${local.trackingUrl}` : "");

  const items = Array.isArray(local.items) ? local.items : [];
  const firstItemTitle = String(items[0]?.name || "").trim();
  const firstProductImage = String(items[0]?.image || "").trim();

  const orderData = {
    orderNumber: local.orderNumber,
    orderId: local.orderId || local._id,
    status: local.status || local.fulfillmentStatus,
    totalPrice: local.totalPrice || local.amount,
    trackingUrl: local.trackingUrl || null,
    currency: "INR",
    itemsSummary: items.map((i) => `• ${i.name} × ${i.quantity || 1}`).join("\n"),
    payment_method: local.paymentMethod || "",
  };

  const mergedMeta = {
    ...baseMeta,
    lastOrder: orderData,
    shopify_order_found: "true",
    last_order_lookup_found: "true",
    shopify_order_id: local.shopifyOrderId || local.orderId,
    order_number: String(label),
    order_status: local.status || local.fulfillmentStatus || "",
    payment_method: local.paymentMethod || "",
    order_total: amt != null ? `₹${amt}` : "",
    is_shipped: /shipped|fulfilled|delivered/i.test(
      String(local.fulfillmentStatus || local.status || "")
    )
      ? "true"
      : "false",
    first_product_title: firstItemTitle,
    first_product_image: firstProductImage,
    last_order_items_count: String(items.length || 0),
  };

  return {
    found: true,
    source: "local",
    userMessage: statusMsg,
    orderData,
    mergedMeta,
  };
}

/**
 * Resolve order for flow `shopify_call` when customer typed order id OR alternate phone.
 * Falls back to WhatsApp phone via resolveLatestOrderContext.
 */
async function resolveOrderContextByIdentifier({ client, phone, identifier }) {
  const raw = String(identifier || "").trim();
  if (!raw) {
    return resolveLatestOrderContext({ client, phone });
  }

  const digits = raw.replace(/\D/g, "");
  const looksPhone = digits.length >= 10;

  if (looksPhone && !/[#A-Za-z]/.test(raw)) {
    const synthetic = digits.length > 10 ? `+${digits}` : digits;
    return resolveLatestOrderContext({ client, phone: synthetic });
  }

  const nameQuery = raw.replace(/^#/, "").trim();
  if (!nameQuery) {
    return resolveLatestOrderContext({ client, phone });
  }

  let shopifyPayload = null;
  try {
    shopifyPayload = await withTimeout(
      withShopifyRetry(client.clientId, async (shopify) => {
      const res = await shopify.get(
        `/orders.json?status=any&limit=5&name=${encodeURIComponent(nameQuery)}`
      );
      const orders = res.data.orders || [];
      if (!orders.length) return null;
      const order = orders[0];
      const li0 = (Array.isArray(order.line_items) ? order.line_items : [])[0];
      const firstProductImage = li0?.product_id
        ? await fetchFirstProductImage(shopify, li0.product_id)
        : "";
      return { order, firstProductImage };
    }),
      5000,
      'OrderLookupByName'
    );
  } catch (e) {
    log.warn("[OrderLookup] name lookup failed", { message: e.message });
  }

  if (!shopifyPayload?.order) {
    return resolveLatestOrderContext({ client, phone });
  }

  const shopifyOrder = shopifyPayload.order;
  const preImage = shopifyPayload.firstProductImage || "";
  const baseMeta = {
    shopify_order_found: "false",
    last_order_lookup_found: "false",
    first_product_title: "",
    first_product_image: "",
  };
  const fulfillStatus =
    shopifyOrder.fulfillment_status || shopifyOrder.financial_status || "Confirmed";
  const lineItems = Array.isArray(shopifyOrder.line_items) ? shopifyOrder.line_items : [];
  const items = lineItems.map((i) => `• ${i.title} × ${i.quantity}`).join("\n");
  const firstItemTitle = String(lineItems[0]?.title || "").trim();
  const tracking = shopifyOrder.fulfillments?.[0]?.tracking_url;
  const payGw = (shopifyOrder.payment_gateway_names || []).join(", ").trim();
  const statusEmoji = {
    pending: "⏳",
    confirmed: "✅",
    processing: "🔄",
    shipped: "🚚",
    delivered: "🎉",
    cancelled: "❌",
    refunded: "💰",
  };
  const emoji = statusEmoji[String(fulfillStatus).toLowerCase()] || "📦";
  let msg = `${emoji} *Order #${shopifyOrder.order_number}*\n\n`;
  msg += `Status: *${String(fulfillStatus).toUpperCase()}*\n`;
  msg += `Items:\n${items || "N/A"}\n`;
  msg += `Total: *${shopifyOrder.currency} ${parseFloat(shopifyOrder.total_price || 0).toFixed(2)}*`;
  if (tracking) msg += `\n\n📍 Track: ${tracking}`;
  if (shopifyOrder.order_status_url) msg += `\n🔗 Details: ${shopifyOrder.order_status_url}`;

  const orderData = {
    orderNumber: shopifyOrder.order_number,
    orderId: shopifyOrder.id,
    status: fulfillStatus,
    totalPrice: shopifyOrder.total_price,
    trackingUrl: tracking || null,
    currency: shopifyOrder.currency,
    itemsSummary: items || "",
    payment_method: payGw,
  };

  const fsRaw = String(shopifyOrder.fulfillment_status || "").toLowerCase();
  const hasFulfillment =
    Array.isArray(shopifyOrder.fulfillments) && shopifyOrder.fulfillments.length > 0;
  const isShippedLike =
    fsRaw === "fulfilled" ||
    fsRaw === "partial" ||
    fsRaw === "shipped" ||
    (hasFulfillment && fsRaw !== "restocked");

  const mergedMeta = {
    ...baseMeta,
    lastOrder: orderData,
    shopify_order_found: "true",
    last_order_lookup_found: "true",
    shopify_order_id: shopifyOrder.id,
    order_number: shopifyOrder.name
      ? String(shopifyOrder.name)
      : `#${shopifyOrder.order_number}`,
    order_status: fulfillStatus,
    payment_method: payGw,
    order_total: shopifyOrder.total_price
      ? `${shopifyOrder.currency || 'INR'} ${parseFloat(shopifyOrder.total_price).toFixed(2)}`
      : '',
    is_shipped: isShippedLike ? "true" : "false",
    first_product_title: firstItemTitle,
    first_product_image: preImage,
    last_order_items_count: String(lineItems.length || 0),
  };

  return {
    found: true,
    source: "shopify_name",
    userMessage: msg,
    orderData,
    mergedMeta,
  };
}

// ---------------------------------------------------------------------------
// GraphQL-based Fetch Latest Order — powers the "Fetch Latest Order" Shopify node
// Returns 8 mapped variables ready to be injected into convo.metadata.
// All variables fall back to "NA" on missing / null data.
// ---------------------------------------------------------------------------

const FETCH_LATEST_ORDER_GQL = `
query getLatestOrderByPhone($phoneString: String!) {
  customers(first: 1, query: $phoneString) {
    nodes {
      lastOrder {
        name
        createdAt
        totalPriceSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress {
          formatted
        }
        lineItems(first: 50) {
          nodes {
            title
            quantity
          }
        }
        fulfillments {
          displayStatus
          status
          trackingInfo(first: 3) {
            company
            number
            url
          }
        }
      }
    }
  }
}
`;

/**
 * Build phone search query strings that Shopify's customer search understands.
 * Shopify normalises customer phones to E.164 in their index, so we try the
 * most likely formats: raw, with country prefix stripped, and E.164-prefixed.
 */
function buildShopifyPhoneQueries(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  const e164 = digits.length >= 10 ? `+${digits}` : null;
  const candidates = new Set();

  if (rawPhone) candidates.add(`phone:${String(rawPhone).trim()}`);
  if (e164) candidates.add(`phone:${e164}`);
  if (digits.length === 12 && digits.startsWith('91')) {
    candidates.add(`phone:+${digits}`);
    candidates.add(`phone:${digits.slice(2)}`);
  }
  if (digits.length === 10) {
    candidates.add(`phone:+91${digits}`);
    candidates.add(`phone:${digits}`);
  }

  return [...candidates].filter(Boolean);
}

/**
 * Fallback value — used for every variable that cannot be resolved.
 */
const NA = 'NA';

function safeStr(val) {
  const s = String(val ?? '').trim();
  return s || NA;
}

/**
 * Map a Shopify GraphQL lastOrder object → 8 flat variables.
 */
function mapOrderToVariables(lastOrder) {
  if (!lastOrder) {
    return {
      order_id: NA,
      order_date: NA,
      ordered_items: NA,
      order_total: NA,
      shipping_address: NA,
      payment_status: NA,
      fulfillment_status: NA,
      delivery_status: NA,
      tracking_link: NA,
    };
  }

  const orderId = safeStr(lastOrder.name);

  let orderDate = NA;
  if (lastOrder.createdAt) {
    try {
      orderDate = new Date(lastOrder.createdAt).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
    } catch (_) {
      orderDate = safeStr(lastOrder.createdAt);
    }
  }

  const lineNodes = Array.isArray(lastOrder.lineItems?.nodes)
    ? lastOrder.lineItems.nodes
    : [];
  const orderedItems = lineNodes.length
    ? lineNodes
        .map((item) => {
          const qty = Number(item.quantity) || 1;
          return qty > 1 ? `${qty}x ${item.title}` : item.title;
        })
        .join('\n')
    : NA;

  const money = lastOrder.totalPriceSet?.presentmentMoney;
  const orderTotal =
    money?.amount && money?.currencyCode
      ? `${parseFloat(money.amount).toFixed(2)} ${money.currencyCode}`
      : NA;

  const formatted = lastOrder.shippingAddress?.formatted;
  const shippingAddress = Array.isArray(formatted)
    ? formatted.filter(Boolean).join(', ') || NA
    : safeStr(formatted);

  const paymentStatus = safeStr(lastOrder.displayFinancialStatus);
  const fulfillmentStatus = safeStr(lastOrder.displayFulfillmentStatus);

  const fulfillments = Array.isArray(lastOrder.fulfillments) ? lastOrder.fulfillments : [];
  const firstFulfillment = fulfillments[0];
  const trackingInfo = Array.isArray(firstFulfillment?.trackingInfo)
    ? firstFulfillment.trackingInfo
    : [];
  const tracking = trackingInfo[0];
  const deliveryStatus = safeStr(
    tracking?.number ||
      tracking?.company ||
      firstFulfillment?.displayStatus ||
      firstFulfillment?.status
  );

  return {
    order_id: orderId,
    order_date: orderDate,
    ordered_items: orderedItems,
    order_total: orderTotal,
    shipping_address: shippingAddress,
    payment_status: paymentStatus,
    fulfillment_status: fulfillmentStatus,
    delivery_status: deliveryStatus,
    tracking_link: safeStr(tracking?.url),
  };
}

/**
 * Map REST / local orderData from resolveLatestOrderContext → same 8 flow variables.
 */
function mapRestOrderDataToVariables(orderData = {}, mergedMeta = {}) {
  if (!orderData || (!orderData.orderId && !orderData.orderNumber)) {
    return mapOrderToVariables(null);
  }

  const orderId = safeStr(
    mergedMeta.order_number || orderData.orderNumber || orderData.orderId
  );
  const orderTotal =
    orderData.currency && orderData.totalPrice != null
      ? `${parseFloat(orderData.totalPrice).toFixed(2)} ${orderData.currency}`
      : NA;

  return {
    order_id: orderId,
    order_date: NA,
    ordered_items: safeStr(orderData.itemsSummary),
    order_total: orderTotal,
    shipping_address: NA,
    payment_status: safeStr(orderData.status),
    fulfillment_status: safeStr(orderData.status),
    delivery_status: NA,
    tracking_link: orderData.trackingUrl ? safeStr(orderData.trackingUrl) : NA,
  };
}

/**
 * Fetch the customer's latest Shopify order using GraphQL.
 *
 * @param {object} params
 * @param {string} params.clientId   - TopEdge client ID
 * @param {string} params.phone      - WhatsApp E.164 or raw phone number
 * @returns {Promise<{found: boolean, variables: object}>}
 *   `variables` always contains all 8 keys; missing data uses "NA".
 */
async function fetchLatestOrderByPhoneGraphQL({ clientId, phone }) {
  const emptyVars = mapOrderToVariables(null);

  const queries = buildShopifyPhoneQueries(phone);
  if (!queries.length) {
    log.warn('[fetchLatestOrderByPhoneGraphQL] No phone variants to try', { phone });
    return { found: false, variables: emptyVars, apiError: null };
  }

  let lastError = null;
  for (const phoneQuery of queries) {
    try {
      const data = await withShopifyGraphQL(clientId, FETCH_LATEST_ORDER_GQL, {
        phoneString: phoneQuery,
      });

      const customerNodes = data?.customers?.nodes;
      if (!Array.isArray(customerNodes) || customerNodes.length === 0) {
        continue;
      }

      const lastOrder = customerNodes[0]?.lastOrder;
      if (!lastOrder) {
        continue;
      }

      return {
        found: true,
        variables: mapOrderToVariables(lastOrder),
        apiError: null,
      };
    } catch (err) {
      lastError = err;
      log.warn('[fetchLatestOrderByPhoneGraphQL] Query attempt failed', {
        phoneQuery,
        message: err.message,
      });
    }
  }

  if (lastError) {
    log.error('[fetchLatestOrderByPhoneGraphQL] All attempts failed', {
      clientId,
      message: lastError.message,
    });
  }

  return {
    found: false,
    variables: emptyVars,
    apiError: lastError ? String(lastError.message || lastError) : null,
  };
}

/**
 * Flow Builder + simulator: GraphQL first, REST/local fallback when GraphQL errors or misses.
 * Optional `identifier` — order ID or alternate phone from convo.metadata (queryVariable).
 */
async function fetchLatestOrderForFlow({ client, phone, identifier }) {
  const clientId = client?.clientId;
  if (!clientId) {
    return {
      found: false,
      lookupFailed: true,
      apiError: 'missing_client',
      variables: mapOrderToVariables(null),
      source: null,
    };
  }

  const storagePhone = sanitizePhoneForStorage(phone) || phone;
  const rawIdentifier = String(identifier || '').trim();

  if (rawIdentifier) {
    const byId = await resolveOrderContextByIdentifier({
      client,
      phone: storagePhone,
      identifier: rawIdentifier,
    });
    if (byId?.found) {
      const variables = mapRestOrderDataToVariables(byId.orderData, byId.mergedMeta || {});
      return {
        found: true,
        lookupFailed: false,
        source: byId.source || 'identifier',
        variables,
        mergedMeta: { last_order_lookup_found: 'true', shopify_order_found: 'true' },
        userMessage: byId.userMessage || null,
        orderData: byId.orderData || null,
      };
    }
    if (byId && byId.found === false) {
      return {
        found: false,
        lookupFailed: false,
        apiError: null,
        source: 'identifier_miss',
        variables: mapOrderToVariables(null),
        mergedMeta: { last_order_lookup_found: 'false' },
        userMessage: byId.userMessage || null,
      };
    }
  }

  const gql = await fetchLatestOrderByPhoneGraphQL({ clientId, phone: storagePhone });
  if (gql.found) {
    return {
      found: true,
      lookupFailed: false,
      source: 'graphql',
      variables: gql.variables,
      mergedMeta: { last_order_lookup_found: 'true', shopify_order_found: 'true' },
      userMessage: null,
    };
  }

  try {
    const legacy = await resolveLatestOrderContext({ client, phone: storagePhone });
    if (legacy?.found) {
      const variables = mapRestOrderDataToVariables(legacy.orderData, legacy.mergedMeta || {});
      return {
        found: true,
        lookupFailed: false,
        source: legacy.source || 'rest',
        variables,
        mergedMeta: { last_order_lookup_found: 'true', shopify_order_found: 'true' },
        userMessage: legacy.userMessage || null,
        orderData: legacy.orderData || null,
      };
    }

    return {
      found: false,
      lookupFailed: Boolean(gql.apiError),
      apiError: gql.apiError,
      source: gql.apiError ? 'graphql_error' : 'none',
      variables: gql.variables,
      mergedMeta: { last_order_lookup_found: 'false' },
      userMessage: legacy?.userMessage || null,
    };
  } catch (err) {
    log.error('[fetchLatestOrderForFlow] REST fallback failed', {
      clientId,
      message: err.message,
    });
    return {
      found: false,
      lookupFailed: true,
      apiError: err.message,
      source: 'failed',
      variables: gql.variables,
      mergedMeta: { last_order_lookup_found: 'false' },
    };
  }
}

module.exports = {
  resolveLatestOrderContext,
  resolveOrderContextByIdentifier,
  findLocalOrder,
  phoneSearchVariants,
  fetchLatestOrderByPhoneGraphQL,
  fetchLatestOrderForFlow,
  mapOrderToVariables,
  mapRestOrderDataToVariables,
};
