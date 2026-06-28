"use strict";

/**
 * CustomerProfile warehouse read model for warranty flow + Audience hub.
 * Canonical source: Contact (phone key) + Order[] + WarrantyRecord per line item.
 * Mirrors GET /warranty/customer-profile enrichment without changing that route.
 */

const Contact = require("../../models/Contact");
const Order = require("../../models/Order");
const WarrantyRecord = require("../../models/WarrantyRecord");
const {
  sanitizePhoneForStorage,
  phoneStorageLookupVariants,
} = require("../core/phoneE164Policy");

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function orderRefKeys(order = {}) {
  const keys = [];
  for (const f of ["shopifyOrderId", "orderId", "orderNumber", "name"]) {
    const v = String(order[f] || "")
      .trim()
      .replace(/^#/, "");
    if (v) keys.push(v);
  }
  return [...new Set(keys)];
}

function collectOrderKeys(orders = []) {
  const keys = new Set();
  for (const o of orders) {
    for (const k of orderRefKeys(o)) keys.add(k);
  }
  return [...keys];
}

function formatOrderDisplay(order, orderKey) {
  const raw =
    order?.shopify_order_name ||
    order?.orderName ||
    order?.name ||
    order?.orderNumber ||
    order?.shopifyOrderId ||
    order?.orderId ||
    orderKey;
  const s = String(raw || "").trim();
  if (!s) return `#${orderKey}`;
  if (s.startsWith("#")) return s;
  if (/^\d+$/.test(s)) return `#${s}`;
  return s;
}

function displayPhone(phone) {
  return sanitizePhoneForStorage(phone) || "";
}

function monthsBetween(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 12;
  let months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  if (e.getDate() < s.getDate()) months -= 1;
  return Math.max(1, months);
}

function durationMonthsForRecord(record) {
  const batch = record?.batchId;
  const productId = String(record?.productId || "").trim();
  if (batch && Array.isArray(batch.productRules) && productId) {
    const rule = batch.productRules.find(
      (r) => String(r.shopifyProductId || "") === productId
    );
    if (rule?.durationMonths) return Number(rule.durationMonths);
  }
  if (batch?.durationMonths) return Number(batch.durationMonths);
  if (record?.purchaseDate && record?.expiryDate) {
    return monthsBetween(record.purchaseDate, record.expiryDate);
  }
  return 12;
}

function formatWarrantyDuration(record) {
  const months = durationMonthsForRecord(record);
  if (months === 12) return "1 Year";
  if (months % 12 === 0 && months >= 12) {
    const years = months / 12;
    return years === 1 ? "1 Year" : `${years} Years`;
  }
  return `${months} months`;
}

function formatWarrantyStatusDisplay(status) {
  const s = String(status || "").toLowerCase();
  if (s === "void") return "Void/Refunded";
  if (s === "active") return "Active";
  if (s === "expired") return "Expired";
  if (s === "terminated") return "Terminated";
  if (!s) return "Unknown";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function findContactByPhone(clientId, rawPhone) {
  const variants = phoneStorageLookupVariants(rawPhone);
  if (!variants.length) return null;
  return Contact.findOne({ clientId, phoneNumber: { $in: variants } }).lean();
}

async function findOrdersByPhone(clientId, rawPhone) {
  const phoneVariants = phoneStorageLookupVariants(rawPhone);
  if (!phoneVariants.length) return [];

  return Order.find({
    clientId,
    $or: [
      { customerPhone: { $in: phoneVariants } },
      { phone: { $in: phoneVariants } },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
}

function buildWarrantyByOrderProduct(warrantyRecords) {
  const map = new Map();
  for (const wr of warrantyRecords) {
    const orderKey = String(wr.shopifyOrderId || "").trim();
    const productKey = String(wr.productId || "").trim();
    const nameKey = String(wr.productName || "").trim();
    if (orderKey && productKey) map.set(`${orderKey}::${productKey}`, wr);
    if (orderKey && nameKey) map.set(`${orderKey}::${nameKey}`, wr);
  }
  return map;
}

/**
 * Build CustomerProfile-shaped data for a normalized phone (Audience > Warranty source).
 */
async function buildWarrantyCustomerProfile(clientId, phone) {
  const cleanPhone = sanitizePhoneForStorage(phone);
  if (!cleanPhone) {
    return {
      customerPhone: "",
      displayPhone: "",
      hasContact: false,
      orderCount: 0,
      orders: [],
      ordersWithWarranty: [],
    };
  }

  let contact = await findContactByPhone(clientId, cleanPhone);
  const orders = await findOrdersByPhone(clientId, cleanPhone);
  const orderKeys = collectOrderKeys(orders);

  const recordQuery = contact
    ? { clientId, customerId: contact._id }
    : orderKeys.length
      ? { clientId, shopifyOrderId: { $in: orderKeys } }
      : null;

  let warrantyRecords = recordQuery
    ? await WarrantyRecord.find(recordQuery)
        .populate("batchId", "batchName durationMonths productRules")
        .sort({ purchaseDate: -1 })
        .lean()
    : [];

  if (!contact && warrantyRecords.length > 0 && warrantyRecords[0]?.customerId) {
    contact = await Contact.findOne({
      _id: warrantyRecords[0].customerId,
      clientId,
    }).lean();
  }

  const warrantyByOrderProduct = buildWarrantyByOrderProduct(warrantyRecords);
  const orderByKey = new Map();
  for (const o of orders) {
    for (const k of orderRefKeys(o)) {
      if (!orderByKey.has(k)) orderByKey.set(k, o);
    }
  }

  const enrichedOrders = orders.map((order) => {
    const orderKey = String(order.shopifyOrderId || order.orderId || order.name || "").trim();
    const rawItems = order.lineItems?.length ? order.lineItems : order.items || [];
    const lineItems = rawItems.map((li) => {
      const productId = String(li.product_id || li.productId || li.sku || "").trim();
      const title = String(li.title || li.name || "Item").trim();
      const wr =
        warrantyByOrderProduct.get(`${orderKey}::${productId}`) ||
        warrantyByOrderProduct.get(`${orderKey}::${title}`) ||
        null;

      let warrantyStatus = null;
      let warranty = { hasWarranty: false };
      if (wr) {
        warrantyStatus = wr.status;
        warranty = {
          hasWarranty: true,
          warrantyStatus,
          recordId: wr._id,
          productName: wr.productName,
          purchaseDate: wr.purchaseDate,
          expiryDate: wr.expiryDate,
          status: wr.status,
          record: wr,
        };
      }

      return {
        title,
        name: title,
        quantity: li.quantity || 1,
        productId,
        warrantyStatus,
        warranty,
      };
    });

    return {
      orderKey,
      orderId: order.shopifyOrderId || order.orderId,
      orderName: order.name || order.orderNumber || order.shopifyOrderId,
      placedAt: order.createdAt,
      lineItems,
      _order: order,
    };
  });

  const grouped = new Map();

  for (const order of enrichedOrders) {
    const covered = order.lineItems.filter(
      (li) => li.warrantyStatus != null && li.warrantyStatus !== undefined && li.warranty?.hasWarranty
    );
    if (!covered.length) continue;

    const key = order.orderKey || String(order.orderId || "").trim();
    grouped.set(key, {
      orderKey: key,
      orderDisplay: formatOrderDisplay(order._order || order, key),
      placedAt: order.placedAt || order._order?.createdAt || null,
      items: covered.map((li) => ({
        productName: li.warranty.productName || li.title,
        status: formatWarrantyStatusDisplay(li.warranty.status),
        duration: formatWarrantyDuration(li.warranty.record),
        record: li.warranty.record,
      })),
    });
  }

  // Warranty records whose order doc is missing from Order collection
  for (const wr of warrantyRecords) {
    const key = String(wr.shopifyOrderId || "").trim();
    if (!key || grouped.has(key)) continue;
    const orderDoc = orderByKey.get(key) || null;
    const entry = grouped.get(key) || {
      orderKey: key,
      orderDisplay: formatOrderDisplay(orderDoc || wr, key),
      placedAt: orderDoc?.createdAt || null,
      items: [],
    };
    const productName = wr.productName || "Item";
    const dup = entry.items.some(
      (i) => i.record?._id && String(i.record._id) === String(wr._id)
    );
    if (!dup) {
      entry.items.push({
        productName,
        status: formatWarrantyStatusDisplay(wr.status),
        duration: formatWarrantyDuration(wr),
        record: wr,
      });
    }
    grouped.set(key, entry);
  }

  const ordersWithWarranty = Array.from(grouped.values())
    .filter((g) => g.items.length > 0)
    .sort((a, b) => {
      const ta = a.placedAt ? new Date(a.placedAt).getTime() : 0;
      const tb = b.placedAt ? new Date(b.placedAt).getTime() : 0;
      return tb - ta;
    });

  return {
    customerPhone: contact?.phoneNumber ? sanitizePhoneForStorage(contact.phoneNumber) : cleanPhone,
    displayPhone: displayPhone(contact?.phoneNumber || cleanPhone),
    hasContact: !!contact,
    orderCount: orders.length,
    orders: enrichedOrders,
    ordersWithWarranty,
    warrantyRecordCount: warrantyRecords.length,
  };
}

function classifyWarrantyScenario(profile) {
  const { orderCount, ordersWithWarranty } = profile;

  if (orderCount === 0 && ordersWithWarranty.length === 0) {
    return "no_customer";
  }
  if (ordersWithWarranty.length === 0) {
    return "orders_no_warranty";
  }
  if (ordersWithWarranty.length === 1) {
    return ordersWithWarranty[0].items.length === 1
      ? "single_order_single_item"
      : "single_order_multi_item";
  }
  return "multi_order";
}

module.exports = {
  buildWarrantyCustomerProfile,
  classifyWarrantyScenario,
  formatWarrantyStatusDisplay,
  formatWarrantyDuration,
  formatOrderDisplay,
  displayPhone,
  orderRefKeys,
};
