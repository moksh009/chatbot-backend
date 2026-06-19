"use strict";

/**
 * Update order shipping address from WhatsApp flow (cancel/modify branch).
 * Syncs to Shopify Admin API and local Order document.
 */

const Order = require("../../models/Order");
const { withShopifyRetry } = require("../shopify/shopifyHelper");
const log = require("../core/logger")("OrderModify");

function parseAddressFromChat(rawText = "") {
  const text = String(rawText || "").trim();
  if (!text) return null;

  const lines = text
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!lines.length) return null;

  const pinMatch = text.match(/\b(\d{6})\b/);
  const zip = pinMatch ? pinMatch[1] : "";

  let city = "";
  let state = "";
  let address1 = "";
  let address2 = "";

  if (lines.length >= 3) {
    address1 = lines[0];
    if (lines.length >= 4) {
      address2 = lines[1];
      city = lines[lines.length - 2] || "";
      const last = lines[lines.length - 1] || "";
      if (!state && last && last !== city && !/^\d{6}$/.test(last)) state = last;
    } else {
      city = lines[lines.length - 1] || "";
      address1 = lines.slice(0, -1).join(", ");
    }
  } else {
    address1 = lines.join(", ");
  }

  if (pinMatch && city.includes(pinMatch[1])) {
    city = city.replace(pinMatch[1], "").replace(/,\s*$/, "").trim();
  }

  return {
    address1: address1 || text,
    address2,
    city,
    state,
    zip,
    country: "India",
  };
}

async function resolveOrderForModify({ client, convo, phone }) {
  const meta = convo?.metadata || {};
  const shopifyId = meta.shopify_order_id || meta.selected_order_id || meta.lastOrder?.orderId;
  const orderNum = meta.order_number || meta.selected_order_name;

  const or = [{ clientId: client.clientId }];
  const clauses = [];
  if (shopifyId && /^\d+$/.test(String(shopifyId))) {
    clauses.push({ shopifyOrderId: String(shopifyId) });
  }
  if (orderNum) {
    const clean = String(orderNum).replace(/^#/, "");
    clauses.push({ orderNumber: clean });
    clauses.push({ orderId: clean });
  }
  if (phone) {
    clauses.push({ customerPhone: phone });
    clauses.push({ phone });
  }
  if (!clauses.length) return null;

  return Order.findOne({ clientId: client.clientId, $or: clauses })
    .sort({ createdAt: -1 })
    .exec();
}

/**
 * @returns {Promise<{ ok: boolean, reason?: string, order?: object }>}
 */
async function updateOrderShippingAddressFromChat({ client, convo, phone, addressText }) {
  const parsed = parseAddressFromChat(addressText);
  if (!parsed?.address1) {
    return { ok: false, reason: "invalid_address" };
  }

  const order = await resolveOrderForModify({ client, convo, phone });
  if (!order) {
    return { ok: false, reason: "order_not_found" };
  }

  const existing =
    order.shippingAddress && typeof order.shippingAddress === "object"
      ? order.shippingAddress
      : {};

  const shippingAddress = {
    address1: parsed.address1,
    address2: parsed.address2 || existing.address2 || "",
    city: parsed.city || existing.city || "",
    state: parsed.state || existing.state || existing.province || "",
    zip: parsed.zip || existing.zip || "",
    country: parsed.country || existing.country || "India",
    first_name:
      existing.first_name ||
      existing.firstName ||
      String(order.customerName || "").trim().split(/\s+/)[0] ||
      "Customer",
    last_name:
      existing.last_name ||
      existing.lastName ||
      String(order.customerName || "").trim().split(/\s+/).slice(1).join(" ") ||
      "",
  };

  if (!shippingAddress.city) {
    return {
      ok: false,
      reason: "missing_city",
      message:
        "Please send your full delivery address including *street, city, and PIN code* (one detail per line).",
    };
  }

  const shopifyNumericId = String(order.shopifyOrderId || "").trim();
  if (client.shopDomain && client.shopifyAccessToken && /^\d+$/.test(shopifyNumericId)) {
    try {
      await withShopifyRetry(client.clientId, async (shopify) => {
        await shopify.put(`/orders/${shopifyNumericId}.json`, {
          order: {
            id: shopifyNumericId,
            shipping_address: {
              address1: shippingAddress.address1,
              address2: shippingAddress.address2,
              city: shippingAddress.city,
              province: shippingAddress.state,
              zip: shippingAddress.zip,
              country: shippingAddress.country,
              first_name: shippingAddress.first_name,
              last_name: shippingAddress.last_name,
            },
          },
        });
      });
    } catch (shopErr) {
      const detail = shopErr.response?.data || shopErr.message;
      log.error("[OrderModify] Shopify address sync failed", { detail });
      return {
        ok: false,
        reason: "shopify_rejected",
        message:
          "We couldn't update your address in the store just now. Our team has been notified and will confirm shortly.",
      };
    }
  }

  order.shippingAddress = shippingAddress;
  order.address = shippingAddress.address1;
  order.city = shippingAddress.city;
  order.state = shippingAddress.state;
  order.zip = shippingAddress.zip;
  await order.save();

  return { ok: true, order: order.toObject ? order.toObject() : order };
}

module.exports = {
  parseAddressFromChat,
  updateOrderShippingAddressFromChat,
  resolveOrderForModify,
};
