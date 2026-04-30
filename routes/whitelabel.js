"use strict";

const express           = require("express");
const router            = express.Router();
const WhitelabelConfig  = require("../models/WhitelabelConfig");
const { verifyToken }   = require("../middleware/auth");

// ─── GET /api/whitelabel/config — return config for current domain ───────────
// Called by the React frontend on mount to apply branding
router.get("/config", async (req, res) => {
  try {
    const hostname = req.hostname;
    const MAIN_DOMAIN = process.env.MAIN_DOMAIN || "chatbot-backend-lg5y.onrender.com";

    if (!hostname || hostname === MAIN_DOMAIN || hostname === "localhost") {
      return res.json({ success: true, whitelabel: null });
    }

    const config = await WhitelabelConfig.findOne({
      customDomain: hostname,
      isActive:     true
    }).lean();

    res.json({ success: true, whitelabel: config || null });
  } catch (err) {
    res.json({ success: true, whitelabel: null }); // Never fail — fall back to default branding
  }
});

// ─── GET /api/whitelabel — list all configs (Super Admin) ──────────────────
router.get("/", verifyToken, async (req, res) => {
  try {
    const configs = await WhitelabelConfig.find({}).sort({ createdAt: -1 }).lean();
    res.json({ success: true, configs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/whitelabel — create config ───────────────────────────────────
router.post("/", verifyToken, async (req, res) => {
  try {
    const { resellerId, productName, primaryColor, accentColor, customDomain, planOverrides, ...rest } = req.body;

    const config = await WhitelabelConfig.create({
      resellerId:   resellerId || req.user?.id,
      productName:  productName || "TopEdge AI",
      primaryColor: primaryColor || "#4F46E5",
      accentColor:  accentColor || "#7C3AED",
      customDomain: (customDomain || "").toLowerCase().trim(),
      planOverrides: planOverrides || [],
      ...rest
    });

    res.status(201).json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/whitelabel/:id — update config ────────────────────────────────
router.put("/:id", verifyToken, async (req, res) => {
  try {
    // Ownership check: only SUPER_ADMIN or the config's reseller can update
    const existing = await WhitelabelConfig.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Config not found" });
    if (req.user.role !== 'SUPER_ADMIN' && String(existing.resellerId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "Unauthorized: you don't own this config" });
    }

    const config = await WhitelabelConfig.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/whitelabel/:id ─────────────────────────────────────────────
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    // Ownership check: only SUPER_ADMIN or the config's reseller can delete
    const existing = await WhitelabelConfig.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Config not found" });
    if (req.user.role !== 'SUPER_ADMIN' && String(existing.resellerId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "Unauthorized: you don't own this config" });
    }

    await WhitelabelConfig.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "White-label config deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/whitelabel/:id/toggle ───────────────────────────────────────
router.patch("/:id/toggle", verifyToken, async (req, res) => {
  try {
    const config = await WhitelabelConfig.findById(req.params.id);
    if (!config) return res.status(404).json({ success: false, message: "Not found" });
    config.isActive = !config.isActive;
    await config.save();
    res.json({ success: true, isActive: config.isActive });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/whitelabel/:id/verify-domain — Check DNS (non-blocking) ──────
// Per plan decision: store the domain, show ⏳ DNS Pending, check async
router.post("/:id/verify-domain", verifyToken, async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ success: false, message: "domain is required" });

    // Save domain immediately (don't block on DNS check)
    await WhitelabelConfig.findByIdAndUpdate(req.params.id, {
      $set: { customDomain: domain.toLowerCase().trim(), domainVerified: false }
    });

    // Non-blocking DNS check
    setImmediate(async () => {
      try {
        const dns     = require("dns").promises;
        const records = await dns.resolveCname(domain);
        const target  = process.env.WHITELABEL_CNAME_TARGET || "white.topedgeai.com";
        const valid   = records.some(r => r.includes(target) || r.includes(process.env.MAIN_DOMAIN || ""));

        if (valid) {
          await WhitelabelConfig.findByIdAndUpdate(req.params.id, {
            $set: { domainVerified: true, domainVerifiedAt: new Date() }
          });
        }
      } catch { /* DNS failed — stays as pending */ }
    });

    res.json({
      success: true,
      message: "Domain saved. DNS verification running in background.",
      instructions: {
        type:  "CNAME",
        host:  domain.split(".").length > 2 ? domain.split(".")[0] : "@",
        value: process.env.WHITELABEL_CNAME_TARGET || "white.topedgeai.com",
        ttl:   3600
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
