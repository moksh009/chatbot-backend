"use strict";

const crypto = require("crypto");
const axios = require("axios");
const CheckoutLink = require("../models/CheckoutLink");
const { normalizePhone } = require("./helpers");
function normalizeStoreBase(shopDomain = "") {
  const clean = String(shopDomain || "").replace(/^https?:\/\//, "").trim();
  return clean ? `https://${clean}` : "";
}

function publicApiBase() {
  const base = process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || process.env.FRONTEND_URL || "";
  return String(base).replace(/\/$/, "") || "";
}

/**
 * Build Shopify cart permalink from WhatsApp order webhook items.
 * product_retailer_id is the Shopify variant id when using Facebook Sales Channel sync.
 */
function buildCartPermalink(clientDoc, productItems = []) {
  const storeBase = normalizeStoreBase(clientDoc?.shopDomain);
  const items = Array.isArray(productItems) ? productItems : [];
  const permalinkParts = [];
  let totalValue = 0;
  let currency = "INR";

  for (const item of items) {
    const vid = String(item?.product_retailer_id ?? item?.variantId ?? "").trim();
    const qty = Math.max(1, Number(item?.quantity || 1) || 1);
    const unit = Number(item?.item_price ?? item?.price ?? 0);
    if (Number.isFinite(unit) && unit > 0) totalValue += unit * qty;
    currency = item?.currency || currency;
    if (vid) permalinkParts.push(`${vid}:${qty}`);
  }

  if (!storeBase || !permalinkParts.length) {
    const fallback = clientDoc?.platformVars?.checkoutUrl || (storeBase ? `${storeBase}/cart` : "");
    return { fullUrl: fallback, totalValue, currency };
  }

  const fullUrl = `${storeBase}/cart/${permalinkParts.join(",")}?checkout&utm_source=whatsapp_catalog&utm_medium=chatbot`;
  return { fullUrl, totalValue, currency };
}

async function tryStorefrontCartCreate(clientDoc, productItems = []) {
  const token = clientDoc?.shopifyStorefrontToken;
  const domain = clientDoc?.shopDomain;
  if (!token || !domain) return null;

  const items = Array.isArray(productItems) ? productItems : [];
  const lines = items
    .map((it) => {
      const vid = String(it?.product_retailer_id ?? it?.variantId ?? "").trim();
      const qty = Math.max(1, Number(it?.quantity || 1) || 1);
      if (!vid) return null;
      return {
        quantity: qty,
        merchandiseId: `gid://shopify/ProductVariant/${vid}`
      };
    })
    .filter(Boolean);

  if (!lines.length) return null;

  const query = `
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { id checkoutUrl }
        userErrors { field message }
      }
    }
  `;
  try {
    const storefrontVer = process.env.SHOPIFY_STOREFRONT_API_VERSION || "2024-01";
    const res = await axios.post(
      `https://${domain}/api/${storefrontVer}/graphql.json`,
      { query, variables: { input: { lines } } },
      {
        headers: {
          "X-Shopify-Storefront-Access-Token": token,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );
    const cart = res.data?.data?.cartCreate?.cart;
    const checkoutUrl = cart?.checkoutUrl;
    if (checkoutUrl) {
      return { fullUrl: checkoutUrl, totalValue: 0, currency: items[0]?.currency || "INR" };
    }
  } catch (e) {
    // fall back to permalink
  }
  return null;
}

/**
 * Creates CheckoutLink and returns short + full URL.
 */
async function createCheckoutLinkRecord({
  clientId,
  phone,
  fullUrl,
  productItems = [],
  totalValue = 0,
  currency = "INR",
  source = "whatsapp_cart"
}) {
  if (!fullUrl) {
    return { shortUrl: "", fullUrl: "", shortCode: "", totalValue, currency };
  }

  const shortCode = crypto.randomBytes(5).toString("hex");
  const mappedItems = (Array.isArray(productItems) ? productItems : []).map((i) => ({
    variantId: String(i?.product_retailer_id ?? i?.variantId ?? "").trim(),
    quantity: Math.max(1, Number(i?.quantity || 1) || 1),
    price: Number(i?.item_price ?? i?.price ?? 0) || 0
  }));

  await CheckoutLink.create({
    clientId,
    phone: phone ? normalizePhone(phone) : "",
    shortCode,
    fullUrl,
    productItems: mappedItems,
    totalValue,
    currency,
    source,
    sent: true
  });

  const base = publicApiBase();
  const shortUrl = base ? `${base}/api/r/${shortCode}` : fullUrl;
  return { shortUrl, fullUrl, shortCode, totalValue, currency };
}

/**
 * Main entry: permalink first unless storefront token yields a URL.
 */
async function generateCheckoutForOrder(clientDoc, phone, productItems = []) {
  let { fullUrl, totalValue, currency } = buildCartPermalink(clientDoc, productItems);

  const sf = await tryStorefrontCartCreate(clientDoc, productItems);
  if (sf?.fullUrl) {
    fullUrl = sf.fullUrl;
    if (!totalValue && productItems.length) {
      totalValue = productItems.reduce(
        (s, i) => s + (Number(i?.item_price ?? i?.price ?? 0) * Number(i?.quantity || 1)),
        0
      );
    }
  }

  const normalized = phone ? normalizePhone(phone) : "";
  const link = await createCheckoutLinkRecord({
    clientId: clientDoc.clientId,
    phone: normalized,
    fullUrl,
    productItems,
    totalValue,
    currency,
    source: "whatsapp_cart"
  });

  return link;
}

module.exports = {
  normalizeStoreBase,
  buildCartPermalink,
  generateCheckoutForOrder,
  createCheckoutLinkRecord,
  publicApiBase
};
