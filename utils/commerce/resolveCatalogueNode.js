"use strict";

/**
 * SSOT for unified Catalogue node (product_list) resolution at runtime.
 * New nodes set catalogueMode: 'product' | 'collection'.
 */

const ShopifyProduct = require("../../models/ShopifyProduct");
const { resolveCatalogId } = require("../meta/metaCatalogSync");

const MAX_PRODUCTS = 30;
const STALE_RATIO_THRESHOLD = 0.5;

function parseProductIds(raw) {
  if (Array.isArray(raw)) {
    return raw.map((id) => String(id).trim()).filter(Boolean);
  }
  return String(raw || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .filter((id) => !/^SHOPIFY_/i.test(id));
}

function isUnifiedCatalogueNode(data = {}) {
  const mode = String(data.catalogueMode || "").toLowerCase();
  return mode === "product" || mode === "collection";
}

function sectionTitleFromData(data = {}) {
  return String(data.sectionTitle || data.header || data.label || "Products").substring(0, 24);
}

function bodyFromData(data = {}) {
  return String(data.body || data.text || "Thank you for shopping with us.").substring(0, 1024);
}

function footerFromData(data = {}) {
  const f = String(data.footer || data.optOutLine || "").trim();
  return f ? f.substring(0, 60) : "Tap to view items";
}

function mapProductsToItems(products = []) {
  return products
    .map((p) => String(p.shopifyVariantId || "").trim())
    .filter(Boolean)
    .slice(0, MAX_PRODUCTS)
    .map((id) => ({ product_retailer_id: id }));
}

async function productsForCollection(clientId, collectionId) {
  const cid = String(collectionId || "").trim();
  if (!cid) return [];
  return ShopifyProduct.find({
    clientId,
    inStock: { $ne: false },
    collectionIds: cid,
  })
    .select("shopifyVariantId title imageUrl price currency")
    .sort({ title: 1 })
    .limit(MAX_PRODUCTS)
    .lean();
}

async function validateProductIds(clientId, ids = []) {
  if (!ids.length) return { valid: [], ratio: 0 };
  const found = await ShopifyProduct.find({
    clientId,
    shopifyVariantId: { $in: ids },
    inStock: { $ne: false },
  })
    .select("shopifyVariantId title imageUrl price currency")
    .lean();
  const validIds = found.map((p) => String(p.shopifyVariantId));
  const ratio = validIds.length / ids.length;
  return { valid: found, validIds, ratio };
}

/**
 * @param {string} clientId
 * @param {object} client - Client lean doc (for catalogId)
 * @param {object} nodeData - catalog node data
 * @returns {Promise<{
 *   ready: boolean,
 *   reason?: string,
 *   catalogId?: string,
 *   body?: string,
 *   header?: string,
 *   footer?: string,
 *   sections?: Array<{ title: string, product_items: Array<{ product_retailer_id: string }> }>,
 *   productPreview?: Array<{ retailerId: string, title: string, imageUrl?: string, price?: number }>,
 * }>}
 */
async function resolveCatalogueNode(clientId, client, nodeData = {}) {
  const catalogId = resolveCatalogId(client) || "";
  const body = bodyFromData(nodeData);
  const sectionTitle = sectionTitleFromData(nodeData);
  const footer = footerFromData(nodeData);

  if (!catalogId) {
    return { ready: false, reason: "no_catalog", body, catalogId: "" };
  }

  const mode = String(nodeData.catalogueMode || "product").toLowerCase();

  if (mode === "collection") {
    const collectionId = String(nodeData.collectionId || "").trim();
    if (!collectionId) {
      return { ready: false, reason: "no_products", catalogId, body };
    }
    const products = await productsForCollection(clientId, collectionId);
    if (!products.length) {
      return { ready: false, reason: "no_products", catalogId, body };
    }
    const product_items = mapProductsToItems(products);
    return {
      ready: true,
      catalogId,
      body,
      header: sectionTitle.substring(0, 60),
      footer,
      sections: [{ title: sectionTitle, product_items }],
      productPreview: products.map((p) => ({
        retailerId: p.shopifyVariantId,
        title: p.title,
        imageUrl: p.imageUrl,
        price: p.price,
        currency: p.currency,
      })),
    };
  }

  // product mode
  const requestedIds = parseProductIds(nodeData.productIds);
  if (!requestedIds.length) {
    return { ready: false, reason: "no_products", catalogId, body };
  }

  const { valid, validIds, ratio } = await validateProductIds(clientId, requestedIds);
  if (!validIds.length) {
    return { ready: false, reason: "no_products", catalogId, body };
  }
  if (ratio < STALE_RATIO_THRESHOLD) {
    return { ready: false, reason: "stale_ids", catalogId, body };
  }

  const orderMap = new Map(requestedIds.map((id, i) => [id, i]));
  const sorted = [...valid].sort(
    (a, b) => (orderMap.get(a.shopifyVariantId) ?? 999) - (orderMap.get(b.shopifyVariantId) ?? 999)
  );

  const product_items = mapProductsToItems(sorted);
  const useSingle = product_items.length === 1 && nodeData.catalogType === "single";

  return {
    ready: true,
    catalogId,
    body,
    header: sectionTitle.substring(0, 60),
    footer,
    sections: [{ title: sectionTitle, product_items }],
    singleProduct: useSingle,
    productRetailerId: useSingle ? product_items[0].product_retailer_id : undefined,
    productPreview: sorted.map((p) => ({
      retailerId: p.shopifyVariantId,
      title: p.title,
      imageUrl: p.imageUrl,
      price: p.price,
      currency: p.currency,
    })),
  };
}

module.exports = {
  resolveCatalogueNode,
  isUnifiedCatalogueNode,
  parseProductIds,
  MAX_PRODUCTS,
  productsForCollection,
};
