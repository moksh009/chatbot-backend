"use strict";

/**
 * Single source of truth for "latest order for this WhatsApp number".
 * Tries Shopify Admin REST (when store is connected), then local Order documents
 * with strict phone matching (no loose regex that can collide across customers).
 */

const Order = require("../models/Order");
const { normalizePhone } = require("./helpers");
const { withShopifyRetry } = require("./shopifyHelper");
const log = require("./logger")("OrderLookup");

function phoneSearchVariants(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  const clean = normalizePhone(raw);
  return [
    String(raw || "").trim(),
    digits,
    last10,
    clean,
    clean ? `+${clean}` : "",
    digits ? `+${digits}` : "",
    last10 && digits.length > 10 ? `91${last10}` : "",
  ]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
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
    shopifyPayload = await withShopifyRetry(client.clientId, async (shopify) => {
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
    });
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

module.exports = {
  resolveLatestOrderContext,
  findLocalOrder,
  phoneSearchVariants,
};
