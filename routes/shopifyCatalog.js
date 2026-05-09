"use strict";

const express = require("express");
const router = express.Router();
const Client = require("../models/Client");
const ShopifyProduct = require("../models/ShopifyProduct");
const ShopifyCollection = require("../models/ShopifyCollection");
const { protect, verifyClientAccess } = require("../middleware/auth");
const shopifyAdminApiVersion = require("../utils/shopifyAdminApiVersion");
const { withShopifyRetry } = require("../utils/shopifyHelper");
const log = require("../utils/logger")("ShopifyCatalog");
const { generateCheckoutForOrder } = require("../utils/commerceCheckoutService");

const SYNC_COOLDOWN_MS = 10 * 60 * 1000;

async function runShopifyCatalogSync(clientId) {
  const client = await Client.findOne({ clientId });
  if (!client) {
    throw new Error("Client not found");
  }

  await Client.updateOne(
    { clientId },
    { $set: { shopifySyncInProgress: true, shopifySyncLastError: "" } }
  );

  let syncedProducts = 0;
  let syncedCollections = 0;

  try {
    await ShopifyProduct.deleteMany({ clientId });

    await withShopifyRetry(clientId, async (shop) => {
      let sinceId = null;
      for (;;) {
        let path = `/products.json?limit=250&status=active`;
        if (sinceId) path += `&since_id=${sinceId}`;
        const res = await shop.get(path);
        const products = res.data?.products || [];
        if (!products.length) break;

        for (const p of products) {
          const variants = p.variants || [];
          for (const v of variants) {
            const price = parseFloat(v.price || "0") || 0;
            await ShopifyProduct.findOneAndUpdate(
              { clientId, shopifyVariantId: String(v.id) },
              {
                $set: {
                  clientId,
                  shopifyProductId: String(p.id),
                  shopifyVariantId: String(v.id),
                  sku: v.sku || "",
                  title: p.title || "",
                  variantTitle: v.title || "",
                  price,
                  currency: "INR",
                  imageUrl: p.image?.src || p.images?.[0]?.src || "",
                  productUrl: client.shopDomain ? `https://${client.shopDomain}/products/${p.handle}` : "",
                  collectionIds: [],
                  collectionTitles: [],
                  inStock: v.inventory_management !== "shopify" || (Number(v.inventory_quantity) || 0) > 0,
                  compareAtPrice: v.compare_at_price ? parseFloat(v.compare_at_price) : undefined,
                  vendor: p.vendor || "",
                  productType: p.product_type || "",
                  tags: typeof p.tags === "string" ? p.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
                  lastSyncedAt: new Date(),
                },
              },
              { upsert: true }
            );
            syncedProducts++;
          }
        }

        sinceId = products[products.length - 1].id;
        if (products.length < 250) break;
      }

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
        syncedCollections++;

        let colSince = null;
        const memberVariantIds = new Set();
        for (;;) {
          let ppath = `/collections/${c.id}/products.json?limit=250`;
          if (colSince) ppath += `&since_id=${colSince}`;
          let pres;
          try {
            pres = await shop.get(ppath);
          } catch (err) {
            log.warn(`collection ${c.id} products fetch: ${err.message}`);
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
          { clientId, shopifyCollectionId: String(c.id) },
          { $set: { productsCount: memberVariantIds.size } }
        );

        for (const vid of memberVariantIds) {
          await ShopifyProduct.updateOne(
            { clientId, shopifyVariantId: vid },
            {
              $addToSet: {
                collectionIds: String(c.id),
                collectionTitles: c.title || "",
              },
            }
          );
        }
      }
    });

    await Client.updateOne(
      { clientId },
      {
        $set: {
          shopifyLastProductSync: new Date(),
          shopifyProductCount: syncedProducts,
          shopifyCollectionCount: syncedCollections,
          catalogSynced: true,
          commerceEnabled: true,
          shopifySyncInProgress: false,
          shopifySyncLastError: "",
        },
      }
    );

    return { synced: syncedProducts, collections: syncedCollections };
  } catch (err) {
    await Client.updateOne(
      { clientId },
      { $set: { shopifySyncInProgress: false, shopifySyncLastError: err.message || String(err) } }
    );
    throw err;
  }
}

router.post("/:clientId/sync-products", protect, verifyClientAccess, async (req, res) => {
  const { clientId } = req.params;
  try {
    const client = await Client.findOne({ clientId }).select(
      "shopifyLastProductSync shopifySyncInProgress shopDomain shopifyAccessToken"
    );
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });
    if (!client.shopDomain || !client.shopifyAccessToken) {
      return res.status(400).json({ success: false, message: "Shopify not connected" });
    }

    const last = client.shopifyLastProductSync ? new Date(client.shopifyLastProductSync).getTime() : 0;
    if (!req.body?.force && last && Date.now() - last < SYNC_COOLDOWN_MS && !client.shopifySyncInProgress) {
      return res.status(429).json({
        success: false,
        message: "Sync allowed once every 10 minutes. Pass force:true to override.",
        retryAfterSec: Math.ceil((SYNC_COOLDOWN_MS - (Date.now() - last)) / 1000),
      });
    }

    res.json({ success: true, started: true, message: "Product sync started in the background" });

    setImmediate(() => {
      runShopifyCatalogSync(clientId).catch((err) => {
        log.error(`Background sync failed for ${clientId}: ${err.message}`);
      });
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/:clientId/collections", protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const rows = await ShopifyCollection.find({ clientId }).sort({ sortOrder: 1, title: 1 }).lean();
    res.json({ success: true, collections: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/:clientId/products", protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { collectionId, limit = 30, search = "" } = req.query;
    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
    const q = { clientId };
    if (collectionId) q.collectionIds = String(collectionId);
    if (search) {
      q.$or = [
        { title: new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        { sku: new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
      ];
    }
    const products = await ShopifyProduct.find(q).sort({ title: 1 }).limit(lim).lean();
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/:clientId/update-collections-config", protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { collections = [] } = req.body || {};
    if (!Array.isArray(collections)) {
      return res.status(400).json({ success: false, message: "collections must be an array" });
    }

    for (let i = 0; i < collections.length; i++) {
      const c = collections[i];
      if (!c.shopifyCollectionId) continue;
      await ShopifyCollection.updateOne(
        { clientId, shopifyCollectionId: String(c.shopifyCollectionId) },
        {
          $set: {
            whatsappMenuLabel: String(c.whatsappMenuLabel || "").slice(0, 24),
            whatsappEnabled: c.whatsappEnabled !== false,
            sortOrder: typeof c.sortOrder === "number" ? c.sortOrder : i,
          },
        }
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Pre-built checkout link (short URL + Shopify cart). Dashboard / agents.
 */
router.post("/:clientId/generate-checkout", protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const clientDoc = await Client.findOne({ clientId }).lean();
    if (!clientDoc) return res.status(404).json({ success: false, message: "Client not found" });

    const { phone, productItems } = req.body || {};
    const items = Array.isArray(productItems)
      ? productItems.map((x) => ({
          product_retailer_id: String(x.variantId || x.product_retailer_id || ""),
          quantity: Math.max(1, Number(x.quantity || 1) || 1),
          item_price: Number(x.price ?? x.item_price ?? 0),
          currency: x.currency || "INR",
        }))
      : [];

    const bundle = await generateCheckoutForOrder(clientDoc, phone, items);
    res.json({
      success: true,
      checkoutUrl: bundle.shortUrl,
      fullUrl: bundle.fullUrl,
      shortCode: bundle.shortCode,
      totalValue: bundle.totalValue,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/:clientId/sync-status", protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const c = await Client.findOne({ clientId }).select(
      "shopifySyncInProgress shopifyLastProductSync shopifySyncLastError shopifyProductCount shopifyCollectionCount"
    );
    if (!c) return res.status(404).json({ success: false });
    res.json({
      success: true,
      inProgress: !!c.shopifySyncInProgress,
      lastSync: c.shopifyLastProductSync,
      error: c.shopifySyncLastError || "",
      productCount: c.shopifyProductCount || 0,
      collectionCount: c.shopifyCollectionCount || 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.runShopifyCatalogSync = runShopifyCatalogSync;
