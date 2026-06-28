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
const { extractPrimaryFulfillment } = require('../shopify/shopifyOrderMapper');
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
      shopifyOrder,
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
    localOrder: local,
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
    shopifyOrder,
    userMessage: msg,
    orderData,
    mergedMeta,
  };
}

// ---------------------------------------------------------------------------
// GraphQL-based Fetch Latest Order — powers the "Fetch Latest Order" Shopify node
// Phone → Shopify customers search → lastOrder → 9 mapped variables (NA fallback)
// ---------------------------------------------------------------------------

/**
 * Mandatory E.164 prep for Shopify customer search (live WA + simulator).
 * Strip spaces, dashes, brackets; ensure leading "+".
 */
function normalizePhoneE164ForShopifyQuery(raw) {
  const stripped = String(raw ?? '')
    .trim()
    .replace(/[\s\-()[\]]/g, '');
  if (!stripped) return '';
  return stripped.startsWith('+') ? stripped : `+${stripped}`;
}

const FETCH_LATEST_ORDER_GQL = `
query getLatestOrderByPhone($phoneQuery: String!) {
  customers(first: 1, query: $phoneQuery) {
    nodes {
      lastOrder {
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        shippingAddress {
          formatted
        }
        lineItems(first: 50) {
          nodes {
            title
            quantity
          }
        }
        fulfillments(first: 1) {
          nodes {
            trackingInfo(first: 1) {
              status
              url
            }
          }
        }
      }
    }
  }
}
`;

/**
 * Build Shopify customer search query string from normalized E.164 phone.
 */
function buildShopifyCustomerPhoneQuery(normalizedE164) {
  const phone = String(normalizedE164 || '').trim();
  if (!phone) return '';
  return `phone:${phone}`;
}

/**
 * Fallback value — used for every variable that cannot be resolved.
 */
const NA = 'NA';

function safeStr(val) {
  const s = String(val ?? '').trim();
  return s || NA;
}

function formatOrderDateValue(raw) {
  if (!raw) return NA;
  try {
    return new Date(raw).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch (_) {
    return safeStr(raw);
  }
}

function formatShippingAddressFormatted(addr) {
  if (!addr || typeof addr !== 'object') return NA;
  const formatted = addr.formatted;
  if (Array.isArray(formatted)) {
    const joined = formatted.filter(Boolean).join(', ');
    return joined || NA;
  }
  if (typeof formatted === 'string' && formatted.trim()) {
    return formatted.trim();
  }
  return NA;
}

/** GraphQL line items: "[title]x [quantity]" per line, newline-separated. */
function formatGraphqlOrderedItems(lineNodes) {
  const items = Array.isArray(lineNodes) ? lineNodes : [];
  if (!items.length) return NA;
  return items
    .map((item) => {
      const title = String(item?.title || 'Item').trim();
      const qty = Number(item?.quantity);
      const quantity = Number.isFinite(qty) && qty > 0 ? qty : 1;
      return `${title}x ${quantity}`;
    })
    .join('\n');
}

/**
 * Resolve first fulfillment tracking info from GraphQL lastOrder (connection or legacy array).
 */
function extractGraphqlTrackingInfo(lastOrder) {
  const fulfillmentConnection = lastOrder?.fulfillments?.nodes;
  const fulfillmentList = Array.isArray(lastOrder?.fulfillments) ? lastOrder.fulfillments : null;
  const firstFulfillment = fulfillmentConnection?.[0] || fulfillmentList?.[0];
  if (!firstFulfillment) {
    return { status: NA, url: NA };
  }

  const trackingRaw = firstFulfillment.trackingInfo;
  let tracking = null;
  if (Array.isArray(trackingRaw)) {
    tracking = trackingRaw[0];
  } else if (trackingRaw && Array.isArray(trackingRaw.nodes)) {
    tracking = trackingRaw.nodes[0];
  } else if (trackingRaw && typeof trackingRaw === 'object') {
    tracking = trackingRaw;
  }

  return {
    status: tracking?.status != null && String(tracking.status).trim() ? safeStr(tracking.status) : NA,
    url: tracking?.url != null && String(tracking.url).trim() ? safeStr(tracking.url) : NA,
  };
}

/**
 * Map a Shopify GraphQL lastOrder object → 9 Shopify Action variables.
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
  const orderDate = lastOrder.createdAt ? formatOrderDateValue(lastOrder.createdAt) : NA;

  const lineNodes = Array.isArray(lastOrder.lineItems?.nodes) ? lastOrder.lineItems.nodes : [];
  const orderedItems = formatGraphqlOrderedItems(lineNodes);

  const money = lastOrder.totalPriceSet?.presentmentMoney;
  const orderTotal =
    money?.amount != null && money?.currencyCode
      ? `${parseFloat(money.amount).toFixed(2)} ${money.currencyCode}`
      : NA;

  const shippingAddress = formatShippingAddressFormatted(lastOrder.shippingAddress);

  const paymentStatus =
    lastOrder.displayFinancialStatus != null && String(lastOrder.displayFinancialStatus).trim()
      ? safeStr(lastOrder.displayFinancialStatus)
      : NA;
  const fulfillmentStatus =
    lastOrder.displayFulfillmentStatus != null && String(lastOrder.displayFulfillmentStatus).trim()
      ? safeStr(lastOrder.displayFulfillmentStatus)
      : NA;

  const { status: deliveryStatus, url: trackingLink } = extractGraphqlTrackingInfo(lastOrder);

  return {
    order_id: orderId,
    order_date: orderDate,
    ordered_items: orderedItems,
    order_total: orderTotal,
    shipping_address: shippingAddress,
    payment_status: paymentStatus,
    fulfillment_status: fulfillmentStatus,
    delivery_status: deliveryStatus,
    tracking_link: trackingLink,
  };
}

function formatStatusLabel(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return NA;
  return s.replace(/_/g, ' ').toUpperCase();
}

function formatAddressObject(addr) {
  if (!addr || typeof addr !== 'object') return NA;
  const formatted = addr.formatted;
  if (Array.isArray(formatted)) {
    const joined = formatted.filter(Boolean).join(', ');
    if (joined) return joined;
  } else if (typeof formatted === 'string' && formatted.trim()) {
    return formatted.trim();
  }
  const parts = [
    addr.name,
    addr.address1,
    addr.address2,
    addr.city,
    addr.province,
    addr.zip,
    addr.country,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : NA;
}

/** REST / local line items — same "[title]x [quantity]" contract as GraphQL path. */
function formatLineItemsList(lineItems) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  if (!items.length) return NA;
  return items
    .map((item) => {
      const title = String(item.title || item.name || 'Item').trim();
      const qty = Number(item.quantity);
      const quantity = Number.isFinite(qty) && qty > 0 ? qty : 1;
      return `${title}x ${quantity}`;
    })
    .join('\n');
}

/**
 * Map Shopify Admin REST order JSON → 9 Shopify Action variables (+ tracking_link).
 */
function mapShopifyRestOrderToVariables(shopifyOrder) {
  if (!shopifyOrder) return mapOrderToVariables(null);

  const orderId = safeStr(
    shopifyOrder.name ||
      (shopifyOrder.order_number != null ? `#${shopifyOrder.order_number}` : '')
  );
  const orderDate = formatOrderDateValue(shopifyOrder.created_at);
  const orderedItems = formatLineItemsList(shopifyOrder.line_items);
  const orderTotal =
    shopifyOrder.total_price != null && shopifyOrder.currency
      ? `${parseFloat(shopifyOrder.total_price).toFixed(2)} ${shopifyOrder.currency}`
      : NA;

  const shippingAddress = formatAddressObject(shopifyOrder.shipping_address);
  const paymentStatus = formatStatusLabel(shopifyOrder.financial_status);
  const fulfillmentStatus = formatStatusLabel(
    shopifyOrder.fulfillment_status || 'unfulfilled'
  );

  const ff = extractPrimaryFulfillment(shopifyOrder);
  const deliveryStatus = safeStr(
    (ff.shipmentStatus && ff.shipmentStatus.replace(/_/g, ' ')) ||
      ff.trackingNumber ||
      shopifyOrder.fulfillments?.[0]?.tracking_number
  );
  const tracking_link = safeStr(
    ff.trackingUrl || shopifyOrder.fulfillments?.[0]?.tracking_url
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
    tracking_link,
  };
}

/**
 * Map local Mongo Order document → same 8 Shopify Action variables.
 */
function mapLocalOrderToVariables(local) {
  if (!local) return mapOrderToVariables(null);

  const items = Array.isArray(local.items) ? local.items : [];
  const orderedItems = items.length ? formatLineItemsList(
    items.map((i) => ({ title: i.name, quantity: i.quantity || 1 }))
  ) : NA;

  const shippingAddress =
    formatAddressObject(local.shippingAddress) !== NA
      ? formatAddressObject(local.shippingAddress)
      : safeStr(local.address);

  const currency = local.currency || 'INR';
  const amt = local.totalPrice ?? local.amount;
  const orderTotal =
    amt != null ? `${parseFloat(amt).toFixed(2)} ${currency}` : NA;

  return {
    order_id: safeStr(local.orderNumber || local.orderId),
    order_date: formatOrderDateValue(local.createdAt),
    ordered_items: orderedItems,
    order_total: orderTotal,
    shipping_address: shippingAddress,
    payment_status: formatStatusLabel(local.financialStatus || local.status),
    fulfillment_status: formatStatusLabel(local.fulfillmentStatus || local.status),
    delivery_status: safeStr(local.lastShipmentStatus || local.trackingNumber),
    tracking_link: safeStr(local.trackingUrl),
  };
}

function resolveFlowVariablesFromLookup(legacy) {
  if (!legacy) return mapOrderToVariables(null);
  if (legacy.shopifyOrder) return mapShopifyRestOrderToVariables(legacy.shopifyOrder);
  if (legacy.localOrder) return mapLocalOrderToVariables(legacy.localOrder);
  return mapRestOrderDataToVariables(legacy.orderData, legacy.mergedMeta || {});
}

/**
 * Map REST / local orderData from resolveLatestOrderContext → same 9 flow variables.
 */
function mapRestOrderDataToVariables(orderData = {}, mergedMeta = {}) {
  if (!orderData || (!orderData.orderId && !orderData.orderNumber)) {
    return mapOrderToVariables(null);
  }

  if (orderData._shopifyRestOrder) {
    return mapShopifyRestOrderToVariables(orderData._shopifyRestOrder);
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
    order_date: orderData.createdAt ? formatOrderDateValue(orderData.createdAt) : NA,
    ordered_items: safeStr(orderData.itemsSummary),
    order_total: orderTotal,
    shipping_address: safeStr(orderData.shippingAddress),
    payment_status: formatStatusLabel(orderData.financialStatus || orderData.payment_status),
    fulfillment_status: formatStatusLabel(orderData.fulfillmentStatus || orderData.status),
    delivery_status: safeStr(orderData.deliveryStatus || orderData.trackingNumber),
    tracking_link: orderData.trackingUrl ? safeStr(orderData.trackingUrl) : NA,
  };
}

/**
 * Fetch the customer's latest Shopify order using GraphQL (live API only).
 *
 * @param {object} params
 * @param {string} params.clientId - TopEdge client ID
 * @param {string} params.phone    - Pre-normalized E.164 (+CC…) or raw (normalized here)
 */
async function fetchLatestOrderByPhoneGraphQL({ clientId, phone }) {
  const emptyVars = mapOrderToVariables(null);
  const normalizedPhone = normalizePhoneE164ForShopifyQuery(phone);
  const phoneQuery = buildShopifyCustomerPhoneQuery(normalizedPhone);

  if (!phoneQuery) {
    log.warn('[fetchLatestOrderByPhoneGraphQL] Invalid phone', { phone });
    return {
      found: false,
      variables: emptyVars,
      apiError: 'invalid_phone',
      normalizedPhone: '',
    };
  }

  try {
    const data = await withShopifyGraphQL(clientId, FETCH_LATEST_ORDER_GQL, {
      phoneQuery,
    });

    const customerNodes = data?.customers?.nodes;
    if (!Array.isArray(customerNodes) || customerNodes.length === 0) {
      log.info('[fetchLatestOrderByPhoneGraphQL] No customer for phone', {
        clientId,
        phoneQuery,
      });
      return { found: false, variables: emptyVars, apiError: null, normalizedPhone };
    }

    const lastOrder = customerNodes[0]?.lastOrder;
    if (!lastOrder) {
      log.info('[fetchLatestOrderByPhoneGraphQL] Customer has no lastOrder', {
        clientId,
        phoneQuery,
      });
      return { found: false, variables: emptyVars, apiError: null, normalizedPhone };
    }

    return {
      found: true,
      variables: mapOrderToVariables(lastOrder),
      apiError: null,
      normalizedPhone,
    };
  } catch (err) {
    log.error('[fetchLatestOrderByPhoneGraphQL] Query failed', {
      clientId,
      phoneQuery,
      message: err.message,
    });
    return {
      found: false,
      variables: emptyVars,
      apiError: String(err.message || err),
      normalizedPhone,
    };
  }
}

/**
 * Flow Builder simulator + live shopify_call CHECK_ORDER_STATUS — GraphQL only (no REST/mock).
 * Phone must come from WhatsApp session (live) or simulator input (test).
 */
async function fetchLatestOrderForFlow({ client, phone }) {
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

  const normalizedPhone = normalizePhoneE164ForShopifyQuery(phone);
  const digitCount = normalizedPhone.replace(/\D/g, '').length;
  if (!normalizedPhone || digitCount < 10) {
    return {
      found: false,
      lookupFailed: false,
      apiError: 'invalid_phone',
      source: 'none',
      variables: mapOrderToVariables(null),
      mergedMeta: { last_order_lookup_found: 'false' },
    };
  }

  const gql = await fetchLatestOrderByPhoneGraphQL({ clientId, phone: normalizedPhone });

  if (gql.found) {
    const variables = gql.variables;
    return {
      found: true,
      lookupFailed: false,
      source: 'graphql',
      variables,
      mergedMeta: {
        last_order_lookup_found: 'true',
        shopify_order_found: 'true',
        lookup_phone: gql.normalizedPhone || normalizedPhone,
        ...variables,
      },
      userMessage: null,
    };
  }

  return {
    found: false,
    lookupFailed: Boolean(gql.apiError && gql.apiError !== 'invalid_phone'),
    apiError: gql.apiError,
    source: gql.apiError ? 'graphql_error' : 'none',
    variables: gql.variables,
    mergedMeta: {
      last_order_lookup_found: 'false',
      shopify_order_found: 'false',
      lookup_phone: gql.normalizedPhone || normalizedPhone,
    },
    userMessage: null,
  };
}

module.exports = {
  resolveLatestOrderContext,
  resolveOrderContextByIdentifier,
  findLocalOrder,
  phoneSearchVariants,
  normalizePhoneE164ForShopifyQuery,
  buildShopifyCustomerPhoneQuery,
  fetchLatestOrderByPhoneGraphQL,
  fetchLatestOrderForFlow,
  mapOrderToVariables,
  mapShopifyRestOrderToVariables,
  mapLocalOrderToVariables,
  mapRestOrderDataToVariables,
  resolveFlowVariablesFromLookup,
};
