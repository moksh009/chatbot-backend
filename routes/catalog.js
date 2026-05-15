"use strict";

const express = require("express");
const router = express.Router();
const Client = require("../models/Client");
const AdLead = require("../models/AdLead");
const ShopifyProduct = require("../models/ShopifyProduct");
const { protect: verifyToken } = require("../middleware/auth");
const { sendCatalogMessage, sendSingleProduct, sendMultiProduct } = require("../utils/whatsappCatalog");
const {
  runMetaCatalogImport,
  resolveCatalogId,
  diagnoseMetaCatalogAccess,
} = require("../utils/metaCatalogSync");
const { autoPatchMpmFlowNodes } = require("../utils/flowMpmPatch");
const log = require("../utils/logger")("CatalogRoutes");

// ─── GET /api/catalog/:clientId — status + product count ────────────────────
router.get("/:clientId", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const cachedCount = await ShopifyProduct.countDocuments({ clientId: req.params.clientId });

    const waOrdersToday = await AdLead.countDocuments({
      clientId: client._id,
      cartStatus: "whatsapp_order_placed",
      lastInteraction: { $gte: new Date(Date.now() - 86400000) },
    });

    const waRevenueAgg = await AdLead.aggregate([
      { $match: { clientId: client._id, cartStatus: "whatsapp_order_placed" } },
      { $group: { _id: null, total: { $sum: "$cartSnapshot.total_price" } } },
    ]);

    const catalogId = resolveCatalogId(client);

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
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/catalog/:clientId/products — cached products (Meta or Shopify) ─
router.get("/:clientId/products", verifyToken, async (req, res) => {
  try {
    const { clientId } = req.params;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const search = String(req.query.search || "").trim();

    const q = { clientId };
    if (search) {
      q.$or = [
        { title: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        { shopifyVariantId: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
      ];
    }

    const products = await ShopifyProduct.find(q).sort({ title: 1 }).limit(limit).lean();
    res.json({ success: true, products, source: "cache" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/catalog/:clientId/diagnose — token + catalog access check ─────
router.get("/:clientId/diagnose", verifyToken, async (req, res) => {
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
        .then((result) => autoPatchMpmFlowNodes(clientId).then((patch) => ({ result, patch })))
        .then(({ result, patch }) => {
          log.info(
            `[Catalog] Auto-import after link: ${result.synced} products, ${patch.patched} flow nodes patched`
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
      const { syncApexCatalogFlowFromMeta } = require("../utils/apexCatalogFlowSync");
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

// ─── GET /api/catalog/:clientId/orders — list WA catalog orders ─────────────
router.get("/:clientId/orders", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;

    const orders = await AdLead.find({
      clientId: client._id,
      cartStatus: "whatsapp_order_placed",
    })
      .select("phoneNumber name cartSnapshot lastInteraction leadScore")
      .sort({ lastInteraction: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({ success: true, orders });
  } catch (err) {
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
