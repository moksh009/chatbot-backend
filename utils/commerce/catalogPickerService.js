"use strict";

/**
 * SSOT for Flow Builder / Journey catalogue picker — live collection counts + product lists.
 * Never trust stale ShopifyCollection.productsCount alone; aggregate from ShopifyProduct.membership.
 */

const Client = require("../../models/Client");
const ShopifyProduct = require("../../models/ShopifyProduct");
const ShopifyCollection = require("../../models/ShopifyCollection");
const { withShopifyRetry } = require("../shopify/shopifyHelper");
const { resolveCatalogId } = require("../meta/metaCatalogSync");
const log = require("../core/logger")("CatalogPicker");

const RECONCILE_COOLDOWN_MS = 5 * 60 * 1000;
const reconcileCooldown = new Map(); // clientId -> timestamp
const reconcileInFlight = new Map(); // clientId -> Promise

const SAMPLE_PICKER_PRODUCTS = [
  { id: "sample_1", shopifyProductId: "sample_1", retailerId: "sample_1", title: "Cotton Kurta — Ivory", price: 2499, currency: "INR", imageUrl: "", inStock: true, collectionIds: ["sample_col_1"] },
  { id: "sample_2", shopifyProductId: "sample_2", retailerId: "sample_2", title: "Linen Shirt — Sage", price: 1899, currency: "INR", imageUrl: "", inStock: true, collectionIds: ["sample_col_1"] },
  { id: "sample_3", shopifyProductId: "sample_3", retailerId: "sample_3", title: "Palazzo Set — Rose", price: 3299, currency: "INR", imageUrl: "", inStock: true, collectionIds: ["sample_col_2"] },
  { id: "sample_4", shopifyProductId: "sample_4", retailerId: "sample_4", title: "Gift Card ₹500", price: 500, currency: "INR", imageUrl: "", inStock: true, collectionIds: [] },
];

const SAMPLE_PICKER_COLLECTIONS = [
  { id: "sample_col_1", title: "Best Sellers", productsCount: 12, imageUrl: "" },
  { id: "sample_col_2", title: "New Arrivals", productsCount: 8, imageUrl: "" },
  { id: "sample_col_3", title: "Home page", productsCount: 24, imageUrl: "" },
];

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mapPickerProduct(row) {
  return {
    id: String(row.shopifyProductId || row.shopifyVariantId || ""),
    shopifyProductId: String(row.shopifyProductId || ""),
    retailerId: String(row.shopifyVariantId || row.shopifyProductId || ""),
    title: row.title || "",
    price: row.price ?? 0,
    currency: row.currency || "INR",
    imageUrl: row.imageUrl || "",
    inStock: row.inStock !== false,
    collectionIds: Array.isArray(row.collectionIds) ? row.collectionIds.map(String) : [],
  };
}

function mapPickerCollection(row, liveCount) {
  const id = String(row.shopifyCollectionId || row.id || "");
  const count = liveCount != null ? liveCount : Number(row.productsCount) || 0;
  return {
    id,
    title: row.title || "",
    productsCount: count,
    imageUrl: row.imageUrl || "",
  };
}

async function aggregateCollectionProductCounts(clientId) {
  const rows = await ShopifyProduct.aggregate([
    { $match: { clientId, inStock: { $ne: false } } },
    { $unwind: "$collectionIds" },
    { $group: { _id: "$collectionIds", count: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) {
    if (r._id) map.set(String(r._id), r.count);
  }
  return map;
}

/**
 * Rebuild collectionIds on cached products from Shopify Admin API (no full product wipe).
 * Creates collection docs from Shopify when missing.
 */
async function importShopifyCollectionsFromApi(clientId, shop) {
  const customCols =
    (await shop.get("/custom_collections.json?limit=250")).data?.custom_collections || [];
  const smartCols =
    (await shop.get("/smart_collections.json?limit=250")).data?.smart_collections || [];

  const allCols = [
    ...customCols.map((c) => ({ ...c, _ctype: "custom" })),
    ...smartCols.map((c) => ({ ...c, _ctype: "smart" })),
  ];

  for (const c of allCols) {
    await ShopifyCollection.findOneAndUpdate(
      { clientId, shopifyCollectionId: String(c.id) },
      {
        $set: {
          clientId,
          shopifyCollectionId: String(c.id),
          title: c.title || "",
          handle: c.handle || "",
          description: c.body_html || "",
          imageUrl: c.image?.src || "",
          collectionType: c._ctype === "smart" ? "smart" : "custom",
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  return allCols.length;
}

async function reconcileCollectionMembership(clientId, shopInstance = null) {
  if (reconcileInFlight.has(clientId)) {
    return reconcileInFlight.get(clientId);
  }

  const job = (async () => {
    const client = await Client.findOne({ clientId }).select("shopDomain shopifyAccessToken");
    if (!client?.shopifyAccessToken || !client.shopDomain) {
      return { collections: 0, links: 0, skipped: true };
    }

    const collections = await ShopifyCollection.find({ clientId })
      .select("shopifyCollectionId title")
      .lean();

    if (!collections.length) {
      return { collections: 0, links: 0, skipped: true };
    }

    let links = 0;

    const runMembership = async (shop) => {
      for (const c of collections) {
        const cid = String(c.shopifyCollectionId);
        let colSince = null;
        const memberVariantIds = new Set();

        for (;;) {
          let ppath = `/collections/${cid}/products.json?limit=250`;
          if (colSince) ppath += `&since_id=${colSince}`;
          let pres;
          try {
            pres = await shop.get(ppath);
          } catch (err) {
            log.warn(`reconcile collection ${cid}: ${err.message}`);
            break;
          }
          const cprods = pres.data?.products || [];
          if (!cprods.length) break;

          for (const p of cprods) {
            for (const v of p.variants || []) {
              memberVariantIds.add(String(v.id));
            }
          }

          colSince = cprods[cprods.length - 1].id;
          if (cprods.length < 250) break;
        }

        await ShopifyCollection.updateOne(
          { clientId, shopifyCollectionId: cid },
          { $set: { productsCount: memberVariantIds.size, lastSyncedAt: new Date() } }
        );

        for (const vid of memberVariantIds) {
          const res = await ShopifyProduct.updateOne(
            { clientId, shopifyVariantId: vid },
            {
              $addToSet: {
                collectionIds: cid,
                collectionTitles: c.title || "",
              },
            }
          );
          if (res.modifiedCount || res.matchedCount) links++;
        }
      }
    };

    if (shopInstance) {
      await runMembership(shopInstance);
    } else {
      await withShopifyRetry(clientId, runMembership);
    }

    reconcileCooldown.set(clientId, Date.now());
    log.info(`[CatalogPicker] Reconciled ${clientId}: ${collections.length} collections, ${links} product links`);
    return { collections: collections.length, links, skipped: false };
  })().finally(() => reconcileInFlight.delete(clientId));

  reconcileInFlight.set(clientId, job);
  return job;
}

async function maybeReconcileCollectionMembership(clientId) {
  const last = reconcileCooldown.get(clientId) || 0;
  if (Date.now() - last < RECONCILE_COOLDOWN_MS) return false;

  const client = await Client.findOne({ clientId }).select("shopifyAccessToken shopDomain shopifyProductCount");
  if (!client?.shopifyAccessToken) return false;

  const [productTotal, collectionCount, countMap] = await Promise.all([
    ShopifyProduct.countDocuments({ clientId, inStock: { $ne: false } }),
    ShopifyCollection.countDocuments({ clientId }),
    aggregateCollectionProductCounts(clientId),
  ]);

  const aggregatedSum = [...countMap.values()].reduce((a, b) => a + b, 0);
  if (productTotal === 0) return false;
  if (aggregatedSum > 0) {
    reconcileCooldown.set(clientId, Date.now());
    return false;
  }

  if (collectionCount === 0) {
    await withShopifyRetry(clientId, async (shop) => {
      await importShopifyCollectionsFromApi(clientId, shop);
    });
  }

  await reconcileCollectionMembership(clientId);
  return true;
}

async function getPickerMeta(clientId) {
  const client = await Client.findOne({ clientId }).select(
    "waCatalogId facebookCatalogId shopDomain shopifyAccessToken catalogSyncedAt shopifyLastProductSync shopifyProductCount"
  );
  if (!client) return null;
  return {
    client,
    catalogLinked: !!resolveCatalogId(client),
    shopifyConnected: !!(client.shopDomain && client.shopifyAccessToken),
    syncedAt: client.catalogSyncedAt || client.shopifyLastProductSync || null,
  };
}

function samplePickerResponse(type, { search, collectionId, skip, limit, catalogLinked, syncedAt }) {
  const sampleProducts = SAMPLE_PICKER_PRODUCTS.filter((p) => {
    if (collectionId && !p.collectionIds.includes(collectionId)) return false;
    if (!search) return true;
    return p.title.toLowerCase().includes(search.toLowerCase());
  });
  const sampleCollections = SAMPLE_PICKER_COLLECTIONS.filter((c) => {
    if (!search) return true;
    return c.title.toLowerCase().includes(search.toLowerCase());
  });
  return {
    success: true,
    sample: true,
    catalogLinked,
    syncedAt,
    items: type === "products" ? sampleProducts.slice(skip, skip + limit) : [],
    collections: type === "collections" ? sampleCollections.slice(skip, skip + limit) : sampleCollections,
    nextCursor: null,
  };
}

async function listPickerCollections(clientId, { search = "", skip = 0, limit = 50 } = {}) {
  const meta = await getPickerMeta(clientId);
  if (!meta) return { error: { status: 404, message: "Client not found" } };

  if (!meta.shopifyConnected) {
    return {
      body: samplePickerResponse("collections", {
        search,
        skip,
        limit,
        catalogLinked: meta.catalogLinked,
        syncedAt: meta.syncedAt,
      }),
    };
  }

  await maybeReconcileCollectionMembership(clientId);

  const filter = { clientId };
  if (search) {
    filter.title = new RegExp(escapeRegex(search), "i");
  }

  const [rows, total, countMap] = await Promise.all([
    ShopifyCollection.find(filter)
      .select("shopifyCollectionId title productsCount imageUrl")
      .sort({ sortOrder: 1, title: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ShopifyCollection.countDocuments(filter),
    aggregateCollectionProductCounts(clientId),
  ]);

  return {
    body: {
      success: true,
      sample: false,
      catalogLinked: meta.catalogLinked,
      syncedAt: meta.syncedAt,
      items: [],
      collections: rows.map((c) =>
        mapPickerCollection(c, countMap.get(String(c.shopifyCollectionId)))
      ),
      nextCursor: skip + rows.length < total ? String(skip + rows.length) : null,
    },
  };
}

async function listPickerProducts(clientId, { search = "", collectionId = "", skip = 0, limit = 50 } = {}) {
  const meta = await getPickerMeta(clientId);
  if (!meta) return { error: { status: 404, message: "Client not found" } };

  if (!meta.shopifyConnected) {
    return {
      body: samplePickerResponse("products", {
        search,
        collectionId,
        skip,
        limit,
        catalogLinked: meta.catalogLinked,
        syncedAt: meta.syncedAt,
      }),
    };
  }

  if (collectionId) {
    await maybeReconcileCollectionMembership(clientId);
  }

  const filter = { clientId, inStock: { $ne: false } };
  if (collectionId) filter.collectionIds = String(collectionId);
  if (search) {
    filter.$or = [
      { title: new RegExp(escapeRegex(search), "i") },
      { shopifyVariantId: new RegExp(escapeRegex(search), "i") },
    ];
  }

  const maxMs = parseInt(process.env.CATALOG_PRODUCTS_MAX_MS || "8000", 10) || 8000;

  const [rows, total] = await Promise.all([
    ShopifyProduct.find(filter)
      .select("shopifyProductId shopifyVariantId title price currency imageUrl collectionIds inStock")
      .sort({ title: 1 })
      .skip(skip)
      .limit(limit)
      .maxTimeMS(maxMs)
      .lean(),
    ShopifyProduct.countDocuments(filter),
  ]);

  return {
    body: {
      success: true,
      sample: false,
      catalogLinked: meta.catalogLinked,
      syncedAt: meta.syncedAt,
      items: rows.map(mapPickerProduct).filter((p) => p.retailerId),
      collections: [],
      nextCursor: skip + rows.length < total ? String(skip + rows.length) : null,
    },
  };
}

module.exports = {
  SAMPLE_PICKER_PRODUCTS,
  SAMPLE_PICKER_COLLECTIONS,
  mapPickerProduct,
  mapPickerCollection,
  aggregateCollectionProductCounts,
  importShopifyCollectionsFromApi,
  reconcileCollectionMembership,
  maybeReconcileCollectionMembership,
  listPickerCollections,
  listPickerProducts,
};
