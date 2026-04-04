"use strict";

const express           = require("express");
const router            = express.Router();
const Client            = require("../models/Client");
const AdLead            = require("../models/AdLead");
const { verifyToken }   = require("../middleware/auth");
const { getCatalogId, syncProductsToCatalog, sendCatalogMessage, sendSingleProduct, sendMultiProduct } = require("../utils/whatsappCatalog");

// ─── GET /api/catalog/:clientId — status + product count ────────────────────
router.get("/:clientId", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    // Count WA orders
    const waOrdersToday = await AdLead.countDocuments({
      clientId:   client._id,
      cartStatus: "whatsapp_order_placed",
      lastInteraction: { $gte: new Date(Date.now() - 86400000) }
    });

    const waRevenueAgg = await AdLead.aggregate([
      { $match: { clientId: client._id, cartStatus: "whatsapp_order_placed" } },
      { $group: { _id: null, total: { $sum: "$cartSnapshot.total_price" } } }
    ]);

    res.json({
      success:          true,
      catalogId:        client.waCatalogId || null,
      catalogEnabled:   client.catalogEnabled || false,
      productCount:     client.catalogProductCount || 0,
      catalogSyncedAt:  client.catalogSyncedAt || null,
      waOrdersToday,
      waRevenue:        waRevenueAgg[0]?.total || 0
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/catalog/:clientId/link — link catalog ID ─────────────────────
router.post("/:clientId/link", verifyToken, async (req, res) => {
  try {
    const { catalogId } = req.body;
    if (!catalogId) return res.status(400).json({ success: false, message: "catalogId is required" });

    await Client.findOneAndUpdate(
      { clientId: req.params.clientId },
      { $set: { waCatalogId: catalogId, catalogEnabled: true } }
    );
    res.json({ success: true, message: "Catalog linked successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/catalog/:clientId/sync — sync products from Shopify/WC to Meta
router.post("/:clientId/sync", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });
    if (!client.waCatalogId) return res.status(400).json({ success: false, message: "No catalog linked" });

    let products = [];

    // Pull from Shopify if connected
    if (client.shopDomain && client.shopifyAccessToken) {
      const axios = require("axios");
      let url = `https://${client.shopDomain}/admin/api/2024-01/products.json?limit=250&status=active`;
      let hasMore = true;

      while (hasMore && products.length < 500) {
        const resp = await axios.get(url, { headers: { "X-Shopify-Access-Token": client.shopifyAccessToken } });
        const batch = resp.data.products || [];
        products.push(...batch.map(p => ({
          id:          p.id,
          title:       p.title,
          description: p.body_html,
          price:       p.variants?.[0]?.price || "0",
          image:       p.images?.[0]?.src || "",
          available:   p.status === "active" && (p.variants?.[0]?.inventory_quantity || 0) > 0,
          url:         `https://${client.shopDomain}/products/${p.handle}`
        })));
        hasMore = batch.length === 250;
        if (hasMore && resp.headers?.link?.includes('rel="next"')) {
          const match = resp.headers.link.match(/<([^>]+)>; rel="next"/);
          if (match) url = match[1];
          else hasMore = false;
        } else hasMore = false;
      }
    }
    // WooCommerce fallback
    else if (client.woocommerceConnected && client.woocommerceUrl) {
      const axios = require("axios");
      const resp = await axios.get(`${client.woocommerceUrl}/wp-json/wc/v3/products`, {
        params: { per_page: 100, status: "publish" },
        auth: { username: client.woocommerceKey, password: client.woocommerceSecret }
      });
      products = (resp.data || []).map(p => ({
        id:          p.id,
        title:       p.name,
        description: p.description,
        price:       p.price || "0",
        image:       p.images?.[0]?.src || "",
        available:   p.stock_status === "instock",
        url:         p.permalink
      }));
    }
    // Manual/custom products from request body
    else if (req.body.products?.length) {
      products = req.body.products;
    }

    if (!products.length) {
      return res.status(400).json({ success: false, message: "No products found to sync" });
    }

    const synced = await syncProductsToCatalog(client, products);

    await Client.findOneAndUpdate(
      { clientId: req.params.clientId },
      { $set: { catalogSyncedAt: new Date(), catalogProductCount: synced } }
    );

    res.json({ success: true, synced, message: `Synced ${synced} products to Meta catalog` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/catalog/:clientId/orders — list WA catalog orders ─────────────
router.get("/:clientId/orders", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const page  = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const orders = await AdLead.find({
      clientId:   client._id,
      cartStatus: "whatsapp_order_placed"
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
      await sendMultiProduct(client, phone, headerText || "Our Products", bodyText || "Browse our collection:", sections || []);
    } else {
      await sendCatalogMessage(client, phone, bodyText || "Browse our full catalog:", productId);
    }

    res.json({ success: true, message: "Catalog message sent" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
