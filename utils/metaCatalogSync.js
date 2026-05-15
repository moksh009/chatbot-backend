"use strict";

const axios = require("axios");
const Client = require("../models/Client");
const ShopifyProduct = require("../models/ShopifyProduct");
const ShopifyCollection = require("../models/ShopifyCollection");
const {
  getEffectiveWhatsAppAccessToken,
  getEffectiveWhatsAppPhoneNumberId,
  getMetaCatalogAccessTokens,
} = require("./clientWhatsAppCreds");
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
    return "Meta access token invalid or expired — reconnect in Settings.";
  }
  if (code === 100 || code === 803 || err.response?.status === 400) {
    return (
      `Catalog API denied: ${msg}\n\n` +
      "Fix: In Meta Business Settings → System users, create a token with catalog_management " +
      "and assign your product catalog. Paste it in Settings → Commerce → Meta catalog access token. " +
      "Or connect Meta Ads (business_management) under Meta Manager."
    );
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

/** Catalog ID linked to this WhatsApp phone (authoritative for WABA token). */
async function fetchCatalogIdFromPhone(phoneId, token) {
  if (!phoneId || !token) return null;
  const data = await graphGet(`/${phoneId}`, token, { fields: "commerce_settings" });
  const cid = data.commerce_settings?.catalog_id;
  return cid ? String(cid).trim() : null;
}

/** Catalogs linked to WABA — often works with whatsapp_business_management (no catalog_management). */
async function fetchCatalogsFromWaba(wabaId, token) {
  if (!wabaId || !token) return [];
  try {
    const data = await graphGet(`/${wabaId}/product_catalogs`, token, {
      fields: "id,name,product_count",
      limit: 50,
    });
    return (data.data || []).map((c) => ({
      id: String(c.id),
      name: c.name || "",
      productCount: c.product_count || 0,
    }));
  } catch (_) {
    return [];
  }
}

/** Quick catalog metadata probe (validates ID + token pair). */
async function probeCatalog(catalogId, token) {
  return graphGet(`/${catalogId}`, token, { fields: "id,name,product_count" });
}

/** List catalogs the token can access via Business portfolio. */
async function listOwnedCatalogs(token) {
  const catalogs = [];
  try {
    const me = await graphGet("/me", token, { fields: "businesses{id,name}" });
    for (const biz of me.businesses?.data || []) {
      try {
        const data = await graphGet(`/${biz.id}/owned_product_catalogs`, token, {
          fields: "id,name,product_count",
          limit: 50,
        });
        for (const c of data.data || []) {
          catalogs.push({
            id: String(c.id),
            name: c.name || "",
            productCount: c.product_count || 0,
            businessId: String(biz.id),
            businessName: biz.name || "",
          });
        }
      } catch (_) {}
    }
  } catch (_) {}
  return catalogs;
}

async function fetchAllCatalogProducts(catalogId, token) {
  const products = [];
  let after = null;

  for (let page = 0; page < 50; page++) {
    const params = { fields: PRODUCT_FIELDS, limit: PAGE_LIMIT };
    if (after) params.after = after;

    const data = await graphGet(`/${catalogId}/products`, token, params);
    const batch = data.data || [];
    products.push(...batch);

    const next = data.paging?.cursors?.after;
    if (!next || batch.length < PAGE_LIMIT) break;
    after = next;
  }

  return products;
}

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

  const setMembers = new Map();

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
 * Pick catalog ID + token that can list products.
 */
async function tryFetchProducts(catalogId, token, attempts, label) {
  if (!catalogId) return null;
  try {
    await probeCatalog(catalogId, token);
    const products = await fetchAllCatalogProducts(catalogId, token);
    if (products.length > 0) {
      return { catalogId, token, products, source: label };
    }
    attempts.push({ catalogId, label, products: 0 });
  } catch (e) {
    const data = e?.response?.data?.error;
    attempts.push({
      catalogId,
      label,
      error: data?.message || e.message,
      code: data?.code,
    });
  }
  return null;
}

async function resolveCatalogAccess(client) {
  const tokens = getMetaCatalogAccessTokens(client);
  if (!tokens.length) {
    throw new Error("No Meta access token — connect WhatsApp in Settings first.");
  }

  const configuredId = resolveCatalogId(client);
  const phoneId = getEffectiveWhatsAppPhoneNumberId(client);
  const wabaId = String(client.wabaId || client.whatsapp?.wabaId || "").trim();
  const attempts = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const tokenLabel = i === 0 ? "metaCatalogAccessToken" : i === 1 ? "metaAdsToken" : "whatsappToken";

    let catalogId = configuredId;
    if (phoneId) {
      try {
        const fromPhone = await fetchCatalogIdFromPhone(phoneId, token);
        if (fromPhone) catalogId = fromPhone;
      } catch (e) {
        attempts.push({ tokenLabel, step: "phone_commerce_settings", error: e.message });
      }
    }

    let hit = await tryFetchProducts(catalogId, token, attempts, `${tokenLabel}:configured`);
    if (hit) return hit;

    const wabaCatalogs = await fetchCatalogsFromWaba(wabaId, token);
    for (const c of wabaCatalogs) {
      hit = await tryFetchProducts(c.id, token, attempts, `${tokenLabel}:waba_catalog`);
      if (hit) return { ...hit, discovered: wabaCatalogs };
    }

    const owned = await listOwnedCatalogs(token);
    const ordered = [
      ...owned.filter((c) => c.id === configuredId),
      ...owned.filter((c) => c.id !== configuredId).sort((a, b) => (b.productCount || 0) - (a.productCount || 0)),
    ];
    for (const c of ordered) {
      hit = await tryFetchProducts(c.id, token, attempts, `${tokenLabel}:business_catalog`);
      if (hit) return { ...hit, discovered: owned };
    }
  }

  const err = new Error(
    "Could not read products from Meta catalog with any token saved on this account.\n\n" +
      "Common fixes:\n" +
      "1) Settings → Commerce → paste the System User token in **Meta catalog access token** (not WhatsApp token).\n" +
      "2) When generating the token, select app **topedge ai** and enable **catalog_management** + **business_management**.\n" +
      "3) Employee system users often cannot pick catalog_management — ask a Business **Admin** to generate the token or upgrade the system user role.\n" +
      "4) Use the catalog ID from Commerce Manager URL (must match Apexlight_Products / Shopify catalog in your screenshot)."
  );
  err.attempts = attempts;
  err.accessibleCatalogs = [];
  for (const token of tokens) {
    const wabaCats = await fetchCatalogsFromWaba(wabaId, token);
    const owned = await listOwnedCatalogs(token);
    for (const c of [...wabaCats, ...owned]) {
      if (!err.accessibleCatalogs.some((x) => x.id === c.id)) err.accessibleCatalogs.push(c);
    }
  }
  throw err;
}

async function diagnoseMetaCatalogAccess(clientId) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error("Client not found");

  const tokens = getMetaCatalogAccessTokens(client);
  const phoneId = getEffectiveWhatsAppPhoneNumberId(client);
  const configuredId = resolveCatalogId(client);

  const report = {
    clientId,
    configuredCatalogId: configuredId,
    phoneNumberId: phoneId,
    tokenCount: tokens.length,
    hasMetaCatalogAccessToken: !!String(client.metaCatalogAccessToken || "").trim(),
    metaCatalogTokenSaved: !!String(client.metaCatalogAccessToken || "").trim(),
    tokenSourcesTried: ["metaCatalogAccessToken", "metaAdsToken", "whatsappToken"],
    hasMetaAdsToken: !!String(client.metaAdsToken || "").trim(),
    hasWhatsAppToken: !!getEffectiveWhatsAppAccessToken(client),
    phoneLinkedCatalogId: null,
    accessibleCatalogs: [],
    recommendedCatalogId: null,
    canImport: false,
    hint: "",
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (phoneId && !report.phoneLinkedCatalogId) {
      try {
        report.phoneLinkedCatalogId = await fetchCatalogIdFromPhone(phoneId, token);
      } catch (_) {}
    }
    const owned = await listOwnedCatalogs(token);
    for (const c of owned) {
      if (!report.accessibleCatalogs.some((x) => x.id === c.id)) {
        report.accessibleCatalogs.push({ ...c, tokenIndex: i });
      }
    }
  }

  if (report.phoneLinkedCatalogId && report.phoneLinkedCatalogId !== configuredId) {
    report.hint =
      `Dashboard catalog ID (${configuredId}) differs from WhatsApp-linked catalog (${report.phoneLinkedCatalogId}). Use the linked ID.`;
    report.recommendedCatalogId = report.phoneLinkedCatalogId;
  } else if (report.accessibleCatalogs.length) {
    const best = report.accessibleCatalogs.sort(
      (a, b) => (b.productCount || 0) - (a.productCount || 0)
    )[0];
    report.recommendedCatalogId = best.id;
    report.hint = `Token can see catalog "${best.name}" (${best.id}) with ${best.productCount || "?"} products.`;
  }

  try {
    const access = await resolveCatalogAccess(client);
    report.canImport = true;
    report.recommendedCatalogId = access.catalogId;
    report.sampleProductCount = access.products.length;
    report.importSource = access.source || "direct";
  } catch (e) {
    report.canImport = false;
    report.importError = e.message;
    report.attempts = e.attempts;
    if (e.accessibleCatalogs?.length) report.accessibleCatalogs = e.accessibleCatalogs;
  }

  return report;
}

async function runMetaCatalogImport(clientId, opts = {}) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error("Client not found");

  await Client.updateOne(
    { clientId },
    { $set: { shopifySyncInProgress: true, shopifySyncLastError: "" } }
  );

  try {
    const access = await resolveCatalogAccess(client);
    const { catalogId, token, products: rawProducts } = access;

    log.info(
      `[MetaCatalogImport] ${clientId} catalog=${catalogId} products=${rawProducts.length} source=${access.source || "token"}`
    );

    const configured = resolveCatalogId(client);
    if (configuredMismatch(configured, catalogId)) {
      log.warn(
        `[MetaCatalogImport] Using catalog ${catalogId} (token-accessible), not dashboard value ${configured}`
      );
    }

    let sets = [];
    let setMembers = new Map();
    try {
      const ps = await fetchProductSetsWithMembers(catalogId, token);
      sets = ps.sets;
      setMembers = ps.setMembers;
    } catch (err) {
      log.warn(`[MetaCatalogImport] product_sets skipped: ${err.message}`);
    }

    if (!rawProducts.length) {
      throw new Error(
        "Meta catalog returned 0 products. Check that items are approved in Commerce Manager."
      );
    }

    const retailerToCollections = new Map();
    for (const [, { name, retailerIds }] of setMembers) {
      for (const rid of retailerIds) {
        if (!retailerToCollections.has(rid)) retailerToCollections.set(rid, []);
        retailerToCollections.get(rid).push(name);
      }
    }

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

function configuredMismatch(configured, resolved) {
  return configured && resolved && configured !== resolved;
}

module.exports = {
  resolveCatalogId,
  runMetaCatalogImport,
  fetchAllCatalogProducts,
  diagnoseMetaCatalogAccess,
  fetchCatalogIdFromPhone,
  listOwnedCatalogs,
};
