"use strict";

const express           = require("express");
const router            = express.Router();
const QRCode            = require("../models/QRCode");
const QRScan            = require("../models/QRScan");
const Client            = require("../models/Client");
const { verifyToken }   = require("../middleware/auth");
const { createQRCode }  = require("../utils/qrGenerator");

// ─── GET /api/qrcodes/:clientId ─────────────────────────────────────────────
router.get("/:clientId", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const qrcodes = await QRCode.find({ clientId: client._id }).sort({ createdAt: -1 }).lean();

    // Summary stats
    const totalScans  = qrcodes.reduce((s, q) => s + q.scansTotal, 0);
    const totalUnique = qrcodes.reduce((s, q) => s + q.scansUnique, 0);
    const totalConv   = qrcodes.reduce((s, q) => s + q.conversions, 0);

    res.json({ success: true, qrcodes, stats: { total: qrcodes.length, totalScans, totalUnique, totalConv } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/qrcodes/:clientId — create QR code ───────────────────────────
router.post("/:clientId", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const { name, type, config, expiresAt } = req.body;
    if (!name) return res.status(400).json({ success: false, message: "name is required" });

    const qr = await createQRCode(client, { name, type, config, expiresAt });
    res.status(201).json({ success: true, qrcode: qr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/qrcodes/:clientId/:id — update config ─────────────────────────
router.put("/:clientId/:id", verifyToken, async (req, res) => {
  try {
    const { name, type, config, expiresAt } = req.body;
    const qr = await QRCode.findByIdAndUpdate(
      req.params.id,
      { $set: { name, type, config, expiresAt } },
      { new: true }
    );
    res.json({ success: true, qrcode: qr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/qrcodes/:clientId/:id ──────────────────────────────────────
router.delete("/:clientId/:id", verifyToken, async (req, res) => {
  try {
    await QRCode.findByIdAndDelete(req.params.id);
    await QRScan.deleteMany({ qrCodeId: req.params.id });
    res.json({ success: true, message: "QR code deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/qrcodes/:clientId/:id/toggle ────────────────────────────────
router.patch("/:clientId/:id/toggle", verifyToken, async (req, res) => {
  try {
    const qr = await QRCode.findById(req.params.id);
    if (!qr) return res.status(404).json({ success: false, message: "Not found" });
    qr.isActive = !qr.isActive;
    await qr.save();
    res.json({ success: true, isActive: qr.isActive });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/qrcodes/:clientId/:id/image — download PNG ────────────────────
router.get("/:clientId/:id/image", verifyToken, async (req, res) => {
  try {
    const qr = await QRCode.findById(req.params.id).lean();
    if (!qr || !qr.qrImageUrl) return res.status(404).json({ success: false, message: "Not found" });

    // qrImageUrl is a base64 data URL: "data:image/png;base64,..."
    const base64 = qr.qrImageUrl.replace(/^data:image\/png;base64,/, "");
    const buf    = Buffer.from(base64, "base64");

    res.set("Content-Type", "image/png");
    res.set("Content-Disposition", `attachment; filename="qr_${qr.shortCode}.png"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/qrcodes/:clientId/:id/scans — scan history (paginated) ────────
router.get("/:clientId/:id/scans", verifyToken, async (req, res) => {
  try {
    const qr = await QRCode.findById(req.params.id).lean();
    if (!qr) return res.status(404).json({ success: false, message: "Not found" });

    const page  = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const scans = await QRScan.find({ qrCodeId: req.params.id })
      .sort({ scannedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Group scans by day for chart data
    const scansByDay = {};
    scans.forEach(s => {
      const day = new Date(s.scannedAt).toISOString().slice(0, 10);
      scansByDay[day] = (scansByDay[day] || 0) + 1;
    });

    res.json({ success: true, scans, scansByDay, qr: { name: qr.name, scansTotal: qr.scansTotal, scansUnique: qr.scansUnique } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
