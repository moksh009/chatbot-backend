"use strict";

const express = require("express");
const router = express.Router();
const Client = require("../models/Client");
const AdLead = require("../models/AdLead");
const ShopifyProduct = require("../models/ShopifyProduct");
const { protect: verifyToken } = require("../middleware/auth");
const { sendCatalogMessage, sendSingleProduct, sendMultiProduct } = require('../utils/meta/whatsappCatalog');
const {
  runMetaCatalogImport,
  resolveCatalogId,
  diagnoseMetaCatalogAccess,
} = require('../utils/meta/metaCatalogSync');
const { autoPatchMpmFlowNodes } = require('../utils/flow/flowMpmPatch');
const log = require('../utils/core/logger')("CatalogRoutes");
const { apiCache } = require("../middleware/apiCache");
const { getCachedClient } = require('../utils/core/clientCache');

// ─── GET /api/catalog/:clientId — status + product count ────────────────────
router.get("/:clientId", verifyToken, apiCache(30), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const timer = createTimer("GET /api/catalog/:clientId", req.params.clientId || "");
  try {
    const cid = req.params.clientId;
    const client = await getCachedClient(
      cid,
      "waCatalogId facebookCatalogId catalogEnabled catalogProductCount shopifyProductCount catalogSyncedAt shopifyLastProductSync shopDomain shopifyAccessToken"
    );
    if (!client) {
      timer.finish("404");
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    const since = new Date(Date.now() - 86400000);
    const [cachedCount, waOrdersToday, waRevenueAgg] = await Promise.all([
      ShopifyProduct.countDocuments({ clientId: cid }),
      AdLead.countDocuments({
        clientId: cid,
        cartStatus: "whatsapp_order_placed",
        lastInteraction: { $gte: since },
      }),
      AdLead.aggregate([
        { $match: { clientId: cid, cartStatus: "whatsapp_order_placed" } },
        { $group: { _id: null, total: { $sum: "$cartSnapshot.total_price" } } },
      ]),
    ]);

    const catalogId = resolveCatalogId(client);

    timer.finish("200 ok");
    res.json({
      success: true,
      catalogId: catalogId || null,
      catalogEnabled: client.catalogEnabled || !!catalogId,
      productCount: cachedCount || client.catalogProductCount || client.shopifyProductCount || 0,
      catalogSyncedAt: client.catalogSyncedAt || client.shopifyLastProductSync || null,
      shopifyConnected: !!(client.shopDomain && client.shopifyAccessToken),
      waOrdersToday,
      waRevenue: waRevenueAgg[0]?.total || 0,
    });
  } catch (err) {
    timer.finish(`500 ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/catalog/:clientId/products — cached products (Meta or Shopify) ─
const CATALOG_PRODUCTS_MAX_MS = parseInt(process.env.CATALOG_PRODUCTS_MAX_MS || "8000", 10) || 8000;

router.get("/:clientId/products", verifyToken, apiCache(25), async (req, res) => {
  try {
    const { clientId } = req.params;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const search = String(req.query.search || "").trim();

    const queryFilter = { clientId };
    if (search) {
      queryFilter.$or = [
        { title: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        { shopifyVariantId: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
      ];
    }

    const products = await ShopifyProduct.find(queryFilter)
      .select(
        "shopifyProductId shopifyVariantId title price currency imageUrl productUrl inStock collectionTitles clientId"
      )
      .sort({ title: 1 })
      .limit(limit)
      .maxTimeMS(CATALOG_PRODUCTS_MAX_MS)
      .lean();
    res.json({ success: true, products, source: "cache" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/catalog/:clientId/products/:productId — rich product for Live Chat ─
router.get("/:clientId/products/:productId", verifyToken, apiCache(60), async (req, res) => {
  try {
    const { clientId, productId } = req.params;
    const { resolveCachedShopifyProduct } = require("../utils/commerce/resolveCachedShopifyProduct");
    const product = await resolveCachedShopifyProduct(clientId, productId);
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/catalog/:clientId/diagnose — token + catalog access check ─────
router.get("/:clientId/diagnose", verifyToken, apiCache(120), async (req, res) => {
  try {
    const report = await diagnoseMetaCatalogAccess(req.params.clientId);
    res.json({ success: true, ...report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/catalog/:clientId/link — link catalog ID + auto-import ───────
router.post("/:clientId/link", verifyToken, async (req, res) => {
  try {
    const { catalogId, metaCatalogAccessToken } = req.body;
    if (!catalogId) return res.status(400).json({ success: false, message: "catalogId is required" });

    const id = String(catalogId).trim();
    const $set = { waCatalogId: id, facebookCatalogId: id, catalogEnabled: true };
    if (metaCatalogAccessToken && String(metaCatalogAccessToken).trim() && metaCatalogAccessToken !== "••••••••") {
      $set.metaCatalogAccessToken = String(metaCatalogAccessToken).trim();
    }
    await Client.findOneAndUpdate({ clientId: req.params.clientId }, { $set });

    // Auto-import products from Meta catalog in background
    const clientId = req.params.clientId;
    setImmediate(() => {
      runMetaCatalogImport(clientId)
        .then(async (result) => {
          let patch = { mpmPatched: 0 };
          try {
            const { syncApexCatalogFlowFromMeta } = require('../utils/shopify/apexCatalogFlowSync');
            const apexSync = await syncApexCatalogFlowFromMeta(clientId);
            if (apexSync.ok) patch = apexSync;
            else patch = await autoPatchMpmFlowNodes(clientId);
          } catch (syncErr) {
            patch = await autoPatchMpmFlowNodes(clientId);
            log.warn(`[Catalog] Apex MPM patch after link: ${syncErr.message}`);
          }
          return { result, patch };
        })
        .then(({ result, patch }) => {
          log.info(
            `[Catalog] Auto-import after link: ${result.synced} products, ${patch.mpmPatched || patch.patched || 0} MPM nodes patched`
          );
        })
        .catch((err) => log.error(`[Catalog] Auto-import after link failed: ${err.message}`));
    });

    res.json({
      success: true,
      message: "Catalog linked. Importing products from Meta Commerce in the background…",
      catalogId: id,
      importStarted: true,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/catalog/:clientId/patch-flow-mpm — fill MPM productIds on flow ─
router.post("/:clientId/patch-flow-mpm", verifyToken, async (req, res) => {
  const clientId = req.params.clientId;
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const productCount = await ShopifyProduct.countDocuments({ clientId });
    if (!productCount) {
      const catalogId = resolveCatalogId(client);
      if (!catalogId) {
        return res.status(400).json({
          success: false,
          message: "No products in cache. Link a Meta catalog ID first, then sync.",
        });
      }
      await runMetaCatalogImport(clientId);
    }

    let result = { ok: false };
    try {
      const { syncApexCatalogFlowFromMeta } = require('../utils/shopify/apexCatalogFlowSync');
      result = await syncApexCatalogFlowFromMeta(clientId, { flowId: req.body?.flowId });
    } catch (apexErr) {
      log.warn(`[Catalog] patch-flow-mpm apex sync: ${apexErr.message}`);
    }
    if (!result.ok) {
      const patch = await autoPatchMpmFlowNodes(clientId, { flowId: req.body?.flowId });
      result = { ok: true, ...patch, mpmPatched: patch.patched };
    }

    res.json({
      success: true,
      flowId: result.flowId,
      mpmPatched: result.mpmPatched || 0,
      mpmNodesTotal: result.mpmNodesTotal,
      mpmNodesWithIds: result.mpmNodesWithIds,
      mpmNodeIdsMissing: result.mpmNodeIdsMissing || [],
      menuUpdated: !!result.menuUpdated,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/catalog/:clientId/sync — import FROM Meta catalog → cache ────
router.post("/:clientId/sync", verifyToken, async (req, res) => {
  const clientId = req.params.clientId;
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const catalogId = resolveCatalogId(client);
    if (!catalogId) {
      return res.status(400).json({
        success: false,
        message: "No Meta catalog ID linked. Enter your Commerce Manager catalog ID first.",
      });
    }

    const result = await runMetaCatalogImport(clientId);

    let patch = { patched: 0 };
    let categoryMenuSynced = false;
    try {
      const { syncApexCatalogFlowFromMeta } = require('../utils/shopify/apexCatalogFlowSync');
      const apexSync = await syncApexCatalogFlowFromMeta(clientId);
      if (apexSync.ok) {
        patch = { patched: apexSync.mpmPatched || 0, flowId: apexSync.flowId };
        categoryMenuSynced = !!apexSync.menuUpdated;
      }
    } catch (apexErr) {
      log.warn(`[Catalog] Apex menu sync skipped: ${apexErr.message}`);
    }
    if (!patch.patched) {
      patch = await autoPatchMpmFlowNodes(clientId);
    }

    res.json({
      success: true,
      synced: result.synced,
      collections: result.collections,
      flowNodesPatched: patch.patched,
      categoryMenuSynced,
      source: "meta_catalog",
      message: `Imported ${result.synced} products from Meta catalog. Flow updated ${patch.patched} MPM nodes${
        categoryMenuSynced ? " and category menu from Meta collections." : "."
      }`,
    });
  } catch (err) {
    log.error(`[Catalog] sync failed for ${clientId}: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/catalog/:clientId/workspace — status + products + orders (BFF) ─
router.get("/:clientId/workspace", verifyToken, apiCache(25), async (req, res) => {
  const { createTimer } = require("../utils/core/perfLogger");
  const timer = createTimer("GET /api/catalog/:clientId/workspace", req.params.clientId || "");
  try {
    const cid = req.params.clientId;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const search = String(req.query.search || "").trim();

    const client = await getCachedClient(
      cid,
      "waCatalogId facebookCatalogId catalogEnabled catalogProductCount shopifyProductCount catalogSyncedAt shopifyLastProductSync shopDomain shopifyAccessToken"
    );
    if (!client) {
      timer.finish("404");
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    const since = new Date(Date.now() - 86400000);
    const queryFilter = { clientId: cid };
    if (search) {
      queryFilter.$or = [
        { title: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        { shopifyVariantId: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
      ];
    }

    const [cachedCount, waOrdersToday, waRevenueAgg, products, orders] = await Promise.all([
      ShopifyProduct.countDocuments({ clientId: cid }),
      AdLead.countDocuments({
        clientId: cid,
        cartStatus: "whatsapp_order_placed",
        lastInteraction: { $gte: since },
      }),
      AdLead.aggregate([
        { $match: { clientId: cid, cartStatus: "whatsapp_order_placed" } },
        { $group: { _id: null, total: { $sum: "$cartSnapshot.total_price" } } },
      ]),
      ShopifyProduct.find(queryFilter)
        .select(
          "shopifyProductId shopifyVariantId title price currency imageUrl productUrl inStock collectionTitles clientId"
        )
        .sort({ title: 1 })
        .limit(limit)
        .maxTimeMS(CATALOG_PRODUCTS_MAX_MS)
        .lean(),
      AdLead.find({
        clientId: cid,
        cartStatus: "whatsapp_order_placed",
      })
        .select("phoneNumber name cartSnapshot lastInteraction leadScore")
        .sort({ lastInteraction: -1 })
        .limit(20)
        .hint({ clientId: 1, cartStatus: 1 })
        .lean(),
    ]);

    const catalogId = resolveCatalogId(client);

    timer.finish("200 ok");
    res.json({
      success: true,
      status: {
        catalogId: catalogId || null,
        catalogEnabled: client.catalogEnabled || !!catalogId,
        productCount: cachedCount || client.catalogProductCount || client.shopifyProductCount || 0,
        catalogSyncedAt: client.catalogSyncedAt || client.shopifyLastProductSync || null,
        shopifyConnected: !!(client.shopDomain && client.shopifyAccessToken),
        waOrdersToday,
        waRevenue: waRevenueAgg[0]?.total || 0,
      },
      products,
      orders,
      productsSource: "cache",
    });
  } catch (err) {
    timer.finish(`500 ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/catalog/:clientId/orders — list WA catalog orders ─────────────
router.get("/:clientId/orders", verifyToken, apiCache(60), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const timer = createTimer("GET /api/catalog/:clientId/orders", req.params.clientId || "");
  try {
    const cid = req.params.clientId;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);

    const orders = await AdLead.find({
      clientId: cid,
      cartStatus: "whatsapp_order_placed",
    })
      .select("phoneNumber name cartSnapshot lastInteraction leadScore")
      .sort({ lastInteraction: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .hint({ clientId: 1, cartStatus: 1 })
      .lean();

    timer.finish(`200 ok | count=${orders.length}`);
    res.json({ success: true, orders });
  } catch (err) {
    timer.finish(`500 ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/catalog/:clientId/send — send catalog/product message ─────────
router.post("/:clientId/send", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const { phone, type, productId, sections, bodyText, headerText } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "phone is required" });

    if (type === "single") {
      await sendSingleProduct(client, phone, bodyText || "Check out this product:", productId);
    } else if (type === "multi") {
      await sendMultiProduct(
        client,
        phone,
        headerText || "Our Products",
        bodyText || "Browse our collection:",
        sections || []
      );
    } else {
      await sendCatalogMessage(client, phone, bodyText || "Browse our full catalog:", productId);
    }

    res.json({ success: true, message: "Catalog message sent" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
