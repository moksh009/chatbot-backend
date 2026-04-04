"use strict";

const express         = require("express");
const router          = express.Router();
const MetaAd          = require("../models/MetaAd");
const AdLead          = require("../models/AdLead");
const Client          = require("../models/Client");
const { verifyToken } = require("../middleware/auth");
const { syncMetaAds, getAdAccounts } = require("../utils/metaAdsAPI");

// ─── GET /api/meta-ads/:clientId — list all imported ads ────────────────────
router.get("/:clientId", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const { status, campaign } = req.query;
    const filter = { clientId: client._id };
    if (status)   filter.adStatus = status.toUpperCase();
    if (campaign) filter.metaCampaignId = campaign;

    const ads = await MetaAd.find(filter).sort({ "topedgeStats.leadsCount": -1 }).lean();

    // Summary stats
    const totalLeads   = ads.reduce((s, a) => s + a.topedgeStats.leadsCount, 0);
    const totalRevenue = ads.reduce((s, a) => s + a.topedgeStats.revenue, 0);
    const totalSpend   = ads.reduce((s, a) => s + a.insights.spend, 0);
    const avgCPL       = totalLeads > 0 ? (totalSpend / totalLeads).toFixed(2) : 0;
    const bestROI      = ads.length > 0 ? ads.reduce((best, a) => a.topedgeStats.roiPercent > best.topedgeStats.roiPercent ? a : best, ads[0]) : null;

    res.json({
      success: true,
      ads,
      connected: client.metaAdsConnected || false,
      accountName: client.metaAdsAccountName || "",
      stats: { totalLeads, totalRevenue, totalSpend, avgCPL, activeAds: ads.filter(a => a.adStatus === 'ACTIVE').length, bestROI: bestROI?.adName || "—" }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/meta-ads/:clientId/sync — re-import from Meta ────────────────
router.post("/:clientId/sync", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    res.json({ success: true, message: "Sync started in background" });
    // Run async without blocking
    setImmediate(() => syncMetaAds(req.params.clientId).catch(console.error));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/meta-ads/:clientId/:adId/attach — attach flow to ad ───────────
router.put("/:clientId/:adId/attach", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const { attachedFlowId, attachedSequenceId, customWelcomeMessage } = req.body;

    const ad = await MetaAd.findOneAndUpdate(
      { clientId: client._id, metaAdId: req.params.adId },
      { $set: { attachedFlowId: attachedFlowId || "", attachedSequenceId: attachedSequenceId || "", customWelcomeMessage: customWelcomeMessage || "" } },
      { new: true }
    );

    if (!ad) return res.status(404).json({ success: false, message: "Ad not found" });
    res.json({ success: true, ad });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/meta-ads/:clientId/:adId/leads — paginated leads from ad ──────
router.get("/:clientId/:adId/leads", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const page  = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const leads = await AdLead.find({
      clientId:             client._id,
      "adAttribution.adId": req.params.adId
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const total = await AdLead.countDocuments({
      clientId:             client._id,
      "adAttribution.adId": req.params.adId
    });

    res.json({ success: true, leads, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/meta-ads/:clientId/connect-url — OAuth URL ────────────────────
router.get("/:clientId/connect-url", verifyToken, async (req, res) => {
  try {
    const redirectUri = `${process.env.API_BASE || "https://chatbot-backend-lg5y.onrender.com"}/api/oauth/meta-ads/callback`;
    const scopes      = "ads_read,ads_management,business_management";
    const state       = Buffer.from(JSON.stringify({ clientId: req.params.clientId })).toString("base64");

    const url = `https://www.facebook.com/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&state=${state}&response_type=code`;

    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/meta-ads/:clientId/select-account — save ad account ──────────
router.post("/:clientId/select-account", verifyToken, async (req, res) => {
  try {
    const { metaAdAccountId, metaAdsAccountName } = req.body;
    if (!metaAdAccountId) return res.status(400).json({ success: false, message: "metaAdAccountId required" });

    await Client.findOneAndUpdate(
      { clientId: req.params.clientId },
      { $set: { metaAdAccountId, metaAdsAccountName: metaAdsAccountName || "", metaAdsConnected: true } }
    );

    // Kick off initial sync
    setImmediate(() => syncMetaAds(req.params.clientId).catch(console.error));

    res.json({ success: true, message: "Ad account selected and sync started" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
