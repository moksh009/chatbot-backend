"use strict";

const ShopifyProduct = require("../../models/ShopifyProduct");
const Client = require("../../models/Client");
const { stripHtmlText } = require("./stripHtmlText");

function parseHandleFromProductUrl(url) {
  const m = String(url || "").match(/\/products\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : "";
}

function normalizeShopDomain(domain) {
  return String(domain || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}

/**
 * Resolve a Shopify product from local cache (ShopifyProduct + nicheData),
 * then live Shopify Admin API when cache is empty.
 */
async function resolveCachedShopifyProduct(clientId, productRef) {
  const ref = String(productRef || "").trim();
  if (!ref || !clientId) return null;

  const client = await Client.findOne({ clientId })
    .select("shopDomain nicheData.products")
    .lean();

  const nicheProducts = Array.isArray(client?.nicheData?.products) ? client.nicheData.products : [];
  const nicheMatch = nicheProducts.find((p) => String(p.id) === ref);

  let rows = await ShopifyProduct.find({ clientId, shopifyProductId: ref })
    .sort({ imageUrl: -1, title: 1 })
    .lean();

  if (!rows.length) {
    const variantRow = await ShopifyProduct.findOne({ clientId, shopifyVariantId: ref }).lean();
    if (variantRow) rows = [variantRow];
  }

  const domain = normalizeShopDomain(client?.shopDomain);
  const row = rows.find((r) => r.imageUrl) || rows[0];

  if (row) {
    const handle =
      parseHandleFromProductUrl(row.productUrl) ||
      nicheMatch?.handle ||
      "";
    const productUrl =
      row.productUrl ||
      nicheMatch?.url ||
      (domain && handle ? `https://${domain}/products/${handle}` : "");

    return {
      shopifyProductId: String(row.shopifyProductId || ref),
      shopifyVariantId: row.shopifyVariantId ? String(row.shopifyVariantId) : null,
      title: row.title || nicheMatch?.title || "Product",
      imageUrl: row.imageUrl || nicheMatch?.image || "",
      price: row.price ?? nicheMatch?.price ?? null,
      currency: row.currency || "INR",
      productUrl,
      handle: handle || parseHandleFromProductUrl(productUrl),
      description: stripHtmlText(nicheMatch?.description || nicheMatch?.body_html || ""),
    };
  }

  if (nicheMatch) {
    const handle = nicheMatch.handle || parseHandleFromProductUrl(nicheMatch.url);
    const productUrl =
      nicheMatch.url ||
      (domain && handle ? `https://${domain}/products/${handle}` : "");

    return {
      shopifyProductId: String(nicheMatch.id),
      shopifyVariantId: null,
      title: nicheMatch.title || "Product",
      imageUrl: nicheMatch.image || "",
      price: nicheMatch.price ?? null,
      currency: "INR",
      productUrl,
      handle,
      description: stripHtmlText(nicheMatch.description || nicheMatch.body_html || ""),
    };
  }

  const live = await fetchLiveShopifyProduct(clientId, ref);
  if (live) return live;

  return null;
}

/** Live Shopify Admin API lookup when cache is empty (e.g. catalog loaded from shopify-hub). */
async function fetchLiveShopifyProduct(clientId, productId) {
  const id = String(productId || "").trim();
  if (!id || !clientId) return null;

  const client = await Client.findOne({ clientId })
    .select("shopDomain shopifyAccessToken")
    .lean();
  if (!client?.shopDomain || !client?.shopifyAccessToken) return null;

  try {
    const { withShopifyRetry } = require("../shopify/shopifyHelper");
    const product = await withShopifyRetry(clientId, async (shop) => {
      const resp = await shop.get(
        `/products/${id}.json?fields=id,title,handle,body_html,variants,images,status`
      );
      return resp.data?.product || null;
    });
    if (!product || (product.status && product.status !== "active")) return null;

    const domain = normalizeShopDomain(client.shopDomain);
    const handle = product.handle || "";
    const productUrl = domain && handle ? `https://${domain}/products/${handle}` : "";

    return {
      shopifyProductId: String(product.id),
      shopifyVariantId: product.variants?.[0]?.id ? String(product.variants[0].id) : null,
      title: product.title || "Product",
      imageUrl: product.images?.[0]?.src || "",
      price: product.variants?.[0]?.price ?? null,
      currency: "INR",
      productUrl,
      handle,
      description: stripHtmlText(product.body_html || ""),
    };
  } catch {
    return null;
  }
}

/** Frontend snapshot fallback when product was shown in UI but not yet in Mongo cache. */
function resolveProductSnapshot(snapshot, productRef) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const title = String(snapshot.title || "").trim();
  const productUrl = String(snapshot.productUrl || "").trim();
  if (!title || !productUrl) return null;

  const snapId = String(snapshot.shopifyProductId || productRef || "").trim();
  const ref = String(productRef || "").trim();
  if (snapId && ref && snapId !== ref) return null;

  return {
    shopifyProductId: snapId || ref,
    shopifyVariantId: snapshot.shopifyVariantId ? String(snapshot.shopifyVariantId) : null,
    title,
    imageUrl: String(snapshot.imageUrl || "").trim(),
    price: snapshot.price ?? null,
    currency: snapshot.currency || "INR",
    productUrl,
    handle: snapshot.handle || parseHandleFromProductUrl(productUrl),
    description: stripHtmlText(snapshot.description || ""),
  };
}

module.exports = {
  resolveCachedShopifyProduct,
  resolveProductSnapshot,
  stripHtmlText,
  parseHandleFromProductUrl,
};
