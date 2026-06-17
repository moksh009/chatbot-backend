"use strict";

const express = require("express");
const router = express.Router();
const QRCode = require("../models/QRCode");
const QRScan = require("../models/QRScan");
const Client = require("../models/Client");
const { verifyToken } = require("../middleware/auth");
const { verifyTenantScope } = require("../middleware/verifyTenantScope");
const { createQRCode, refreshQRCodeAssets } = require("../utils/core/qrGenerator");
const { qrClientIdFilter, qrBelongsToClient, getClientQrPhoneContext } = require("../utils/core/qrClientScope");

const tenantScope = verifyTenantScope({ clientIdParam: "clientId" });

async function loadClient(req) {
  return Client.findOne({ clientId: req.params.clientId });
}

async function loadOwnedQr(req, client) {
  const qr = await QRCode.findById(req.params.id);
  if (!qr) return null;
  if (!qrBelongsToClient(qr, client)) return null;
  return qr;
}

// ─── GET /api/qrcodes/:clientId ─────────────────────────────────────────────
router.get("/:clientId", verifyToken, tenantScope, async (req, res) => {
  try {
    const client = await loadClient(req);
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const qrcodes = await QRCode.find(qrClientIdFilter(client)).sort({ createdAt: -1 }).lean();

    const totalScans  = qrcodes.reduce((s, q) => s + (q.scansTotal || 0), 0);
    const totalUnique = qrcodes.reduce((s, q) => s + (q.scansUnique || 0), 0);
    const totalConv   = qrcodes.reduce((s, q) => s + (q.conversions || 0), 0);
    const phoneCtx = await getClientQrPhoneContext(client);

    res.json({
      success: true,
      qrcodes,
      stats: { total: qrcodes.length, totalScans, totalUnique, totalConv },
      whatsappConnected: phoneCtx.whatsappConnected,
      waPhoneConfigured: phoneCtx.waPhoneConfigured,
      waDisplayPhone: phoneCtx.waDisplayPhone,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/qrcodes/:clientId — create QR code ───────────────────────────
router.post("/:clientId", verifyToken, tenantScope, async (req, res) => {
  try {
    const client = await loadClient(req);
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const { name, type, config, expiresAt } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const qr = await createQRCode(client, { name: String(name).trim(), type, config, expiresAt });
    res.status(201).json({ success: true, qrcode: qr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/qrcodes/:clientId/:id — update config ─────────────────────────
router.put("/:clientId/:id", verifyToken, tenantScope, async (req, res) => {
  try {
    const client = await loadClient(req);
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const qr = await loadOwnedQr(req, client);
    if (!qr) return res.status(404).json({ success: false, message: "Not found" });

    const { name, type, config, expiresAt } = req.body;
    if (name != null) qr.name = String(name).trim();
    if (type != null) qr.type = type;
    if (config != null) qr.config = { ...(qr.config || {}), ...config };
    if (expiresAt !== undefined) qr.expiresAt = expiresAt;

    await refreshQRCodeAssets(client, qr);
    await qr.save();

    res.json({ success: true, qrcode: qr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/qrcodes/:clientId/:id ──────────────────────────────────────
router.delete("/:clientId/:id", verifyToken, tenantScope, async (req, res) => {
  try {
    const client = await loadClient(req);
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const qr = await loadOwnedQr(req, client);
    if (!qr) return res.status(404).json({ success: false, message: "Not found" });

    await QRCode.findByIdAndDelete(qr._id);
    await QRScan.deleteMany({ qrCodeId: qr._id });
    res.json({ success: true, message: "QR code deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/qrcodes/:clientId/:id/toggle ────────────────────────────────
router.patch("/:clientId/:id/toggle", verifyToken, tenantScope, async (req, res) => {
  try {
    const client = await loadClient(req);
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const qr = await loadOwnedQr(req, client);
    if (!qr) return res.status(404).json({ success: false, message: "Not found" });

    qr.isActive = !qr.isActive;
    await qr.save();
    res.json({ success: true, isActive: qr.isActive, qrcode: qr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/qrcodes/:clientId/:id/image — download PNG ────────────────────
router.get("/:clientId/:id/image", verifyToken, tenantScope, async (req, res) => {
  try {
    const client = await loadClient(req);
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const qr = await loadOwnedQr(req, client);
    if (!qr || !qr.qrImageUrl) return res.status(404).json({ success: false, message: "Not found" });

    const base64 = qr.qrImageUrl.replace(/^data:image\/png;base64,/, "");
    const buf = Buffer.from(base64, "base64");

    res.set("Content-Type", "image/png");
    res.set("Content-Disposition", `attachment; filename="qr_${qr.shortCode}.png"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/qrcodes/:clientId/:id/scans — scan history (paginated) ────────
router.get("/:clientId/:id/scans", verifyToken, tenantScope, async (req, res) => {
  try {
    const client = await loadClient(req);
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const qr = await loadOwnedQr(req, client);
    if (!qr) return res.status(404).json({ success: false, message: "Not found" });

    const page  = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const scans = await QRScan.find({ qrCodeId: qr._id })
      .sort({ scannedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const scansByDay = {};
    scans.forEach((s) => {
      const day = new Date(s.scannedAt).toISOString().slice(0, 10);
      scansByDay[day] = (scansByDay[day] || 0) + 1;
    });

    res.json({
      success: true,
      scans,
      scansByDay,
      qr: { name: qr.name, scansTotal: qr.scansTotal, scansUnique: qr.scansUnique },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/qrcodes/:clientId/preview — live PNG preview (no save) ─────────
router.post("/:clientId/preview", verifyToken, tenantScope, async (req, res) => {
  try {
    const client = await loadClient(req);
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const { buildWaLink, generateQRImage } = require("../utils/core/qrGenerator");
    const config = req.body?.config || {};
    const shortCode = String(req.body?.shortCode || "QR_PREVIEW1").toUpperCase();
    const phoneCtx = await getClientQrPhoneContext(client);
    const waLink = await buildWaLink(client, shortCode, config);
    const fgColor = config?.styleConfig?.fgColor || "#000000";
    const bgColor = config?.styleConfig?.bgColor || "#FFFFFF";
    const qrImageUrl = await generateQRImage(waLink, fgColor, bgColor);

    res.json({
      success: true,
      waLink,
      qrImageUrl,
      shortCode,
      whatsappConnected: phoneCtx.whatsappConnected,
      waPhoneConfigured: phoneCtx.waPhoneConfigured,
      waDisplayPhone: phoneCtx.waDisplayPhone,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
