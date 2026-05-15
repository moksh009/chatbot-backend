"use strict";

const axios = require("axios");
const Client = require("../models/Client");
const ShopifyProduct = require("../models/ShopifyProduct");
const ShopifyCollection = require("../models/ShopifyCollection");
const { getEffectiveWhatsAppAccessToken } = require("./clientWhatsAppCreds");
const log = require("./logger")("MetaCatalogSync");

const GRAPH = "https://graph.facebook.com/v21.0";
const PRODUCT_FIELDS =
  "id,retailer_id,name,description,price,currency,availability,image_url,url,brand,category,product_type";
const PAGE_LIMIT = 100;

function resolveCatalogId(client) {
  return String(
    client?.facebookCatalogId ||
      client?.waCatalogId ||
      client?.metaCatalogId ||
      client?.commerceBotSettings?.facebookCatalogId ||
      ""
  ).trim();
}

function parseMetaPrice(priceStr) {
  if (priceStr == null) return 0;
  const s = String(priceStr).replace(/,/g, "");
  const m = s.match(/([\d]+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseCurrency(priceStr, fallback = "INR") {
  if (!priceStr) return fallback;
  const s = String(priceStr).toUpperCase();
  if (s.includes("INR") || s.includes("₹")) return "INR";
  if (s.includes("USD")) return "USD";
  return fallback;
}

function isAvailable(availability) {
  const a = String(availability || "").toLowerCase();
  return a === "in stock" || a === "available for order" || a === "preorder";
}

function graphErrorMessage(err) {
  const data = err?.response?.data?.error;
  if (!data) return err.message || String(err);
  const code = data.code;
  const msg = data.message || data.error_user_msg || "Meta API error";
  if (code === 190 || err.response?.status === 401) {
    return "WhatsApp token invalid or expired — reconnect WhatsApp in Settings.";
  }
  if (code === 100 || code === 803) {
    return `Catalog access denied: ${msg}. Ensure the token has catalog_management permission.`;
  }
  return msg;
}

async function graphGet(path, token, params = {}) {
  const resp = await axios.get(`${GRAPH}${path}`, {
    params: { access_token: token, ...params },
    timeout: 60000,
  });
  return resp.data;
}

/**
 * Fetch all products from a Meta Commerce catalog (already linked to Shopify on Meta's side).
 */
async function fetchAllCatalogProducts(catalogId, token) {
  const products = [];
  let url = `/${catalogId}/products`;
  let after = null;

  for (let page = 0; page < 50; page++) {
    const params = { fields: PRODUCT_FIELDS, limit: PAGE_LIMIT };
    if (after) params.after = after;

    const data = await graphGet(url, token, params);
    const batch = data.data || [];
    products.push(...batch);

    const next = data.paging?.cursors?.after;
    if (!next || batch.length < PAGE_LIMIT) break;
    after = next;
  }

  return products;
}

/**
 * Fetch product sets (Meta's version of collections) and member retailer_ids.
 */
async function fetchProductSetsWithMembers(catalogId, token) {
  const sets = [];
  let after = null;

  for (let page = 0; page < 20; page++) {
    const params = { fields: "id,name,product_count", limit: 50 };
    if (after) params.after = after;

    const data = await graphGet(`/${catalogId}/product_sets`, token, params);
    const batch = data.data || [];
    sets.push(...batch);

    const next = data.paging?.cursors?.after;
    if (!next || batch.length < 50) break;
    after = next;
  }

  const setMembers = new Map(); // setId → { name, retailerIds: Set }

  for (const set of sets) {
    const retailerIds = new Set();
    let prodAfter = null;

    for (let p = 0; p < 30; p++) {
      const pParams = { fields: "retailer_id", limit: PAGE_LIMIT };
      if (prodAfter) pParams.after = prodAfter;

      const pdata = await graphGet(`/${set.id}/products`, token, pParams);
      for (const pr of pdata.data || []) {
        if (pr.retailer_id) retailerIds.add(String(pr.retailer_id));
      }

      const next = pdata.paging?.cursors?.after;
      if (!next || (pdata.data || []).length < PAGE_LIMIT) break;
      prodAfter = next;
    }

    setMembers.set(String(set.id), { name: set.name || "", retailerIds });
  }

  return { sets, setMembers };
}

/**
 * Import Meta Commerce catalog → MongoDB product cache (ShopifyProduct + ShopifyCollection).
 * No Shopify API access required — products already live in Meta's catalog.
 */
async function runMetaCatalogImport(clientId, opts = {}) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error("Client not found");

  const catalogId = resolveCatalogId(client);
  if (!catalogId) throw new Error("No Meta catalog ID linked. Enter catalog ID in Meta Manager → Catalog.");

  const token = getEffectiveWhatsAppAccessToken(client);
  if (!token) throw new Error("WhatsApp access token missing — connect WhatsApp in Settings first.");

  await Client.updateOne(
    { clientId },
    { $set: { shopifySyncInProgress: true, shopifySyncLastError: "" } }
  );

  try {
    log.info(`[MetaCatalogImport] ${clientId} catalog=${catalogId}`);

    const [rawProducts, { sets, setMembers }] = await Promise.all([
      fetchAllCatalogProducts(catalogId, token),
      fetchProductSetsWithMembers(catalogId, token).catch((err) => {
        log.warn(`[MetaCatalogImport] product_sets skipped: ${err.message}`);
        return { sets: [], setMembers: new Map() };
      }),
    ]);

    if (!rawProducts.length) {
      throw new Error(
        "Meta catalog returned 0 products. Check catalog ID and that products are approved in Commerce Manager."
      );
    }

    // retailer_id → collection titles from product sets
    const retailerToCollections = new Map();
    for (const [setId, { name, retailerIds }] of setMembers) {
      for (const rid of retailerIds) {
        if (!retailerToCollections.has(rid)) retailerToCollections.set(rid, []);
        retailerToCollections.get(rid).push(name);
      }
    }

    // Replace cache for this client (Meta is source of truth when Shopify isn't connected)
    if (!opts.mergeOnly) {
      await ShopifyProduct.deleteMany({ clientId });
    }

    let synced = 0;
    for (const p of rawProducts) {
      const retailerId = String(p.retailer_id || "").trim();
      if (!retailerId) continue;

      const available = isAvailable(p.availability);
      const colTitles = retailerToCollections.get(retailerId) || [];
      const category = p.category || p.product_type || "";

      await ShopifyProduct.findOneAndUpdate(
        { clientId, shopifyVariantId: retailerId },
        {
          $set: {
            clientId,
            shopifyProductId: String(p.id || retailerId),
            shopifyVariantId: retailerId,
            sku: retailerId,
            title: p.name || "Product",
            variantTitle: "",
            price: parseMetaPrice(p.price),
            currency: p.currency || parseCurrency(p.price, "INR"),
            imageUrl: p.image_url || "",
            productUrl: p.url || "",
            collectionIds: [],
            collectionTitles: [...new Set(colTitles.filter(Boolean))],
            inStock: available,
            vendor: p.brand || "",
            productType: category,
            tags: ["meta_catalog", ...(category ? [category] : [])],
            lastSyncedAt: new Date(),
          },
        },
        { upsert: true }
      );
      synced++;
    }

    // Sync product sets as collections
    let syncedCollections = 0;
    for (const set of sets) {
      const sid = String(set.id);
      const members = setMembers.get(sid);
      await ShopifyCollection.findOneAndUpdate(
        { clientId, shopifyCollectionId: sid },
        {
          $set: {
            clientId,
            shopifyCollectionId: sid,
            title: set.name || "Collection",
            handle: (set.name || "").toLowerCase().replace(/\s+/g, "-"),
            description: "",
            imageUrl: "",
            productsCount: members?.retailerIds?.size || set.product_count || 0,
            collectionType: "custom",
            lastSyncedAt: new Date(),
          },
        },
        { upsert: true }
      );
      syncedCollections++;

      if (members?.retailerIds) {
        for (const rid of members.retailerIds) {
          await ShopifyProduct.updateOne(
            { clientId, shopifyVariantId: rid },
            {
              $addToSet: {
                collectionIds: sid,
                collectionTitles: set.name || "",
              },
            }
          );
        }
      }
    }

    const now = new Date();
    await Client.updateOne(
      { clientId },
      {
        $set: {
          waCatalogId: catalogId,
          facebookCatalogId: catalogId,
          catalogEnabled: true,
          catalogSynced: true,
          catalogSyncedAt: now,
          catalogProductCount: synced,
          shopifyLastProductSync: now,
          shopifyProductCount: synced,
          shopifyCollectionCount: syncedCollections,
          shopifySyncInProgress: false,
          shopifySyncLastError: "",
          commerceEnabled: true,
        },
      }
    );

    log.info(`[MetaCatalogImport] Done ${clientId}: ${synced} products, ${syncedCollections} collections`);

    return { synced, collections: syncedCollections, catalogId, source: "meta_catalog" };
  } catch (err) {
    const msg = graphErrorMessage(err);
    await Client.updateOne(
      { clientId },
      { $set: { shopifySyncInProgress: false, shopifySyncLastError: msg } }
    );
    throw new Error(msg);
  }
}

module.exports = {
  resolveCatalogId,
  runMetaCatalogImport,
  fetchAllCatalogProducts,
};
