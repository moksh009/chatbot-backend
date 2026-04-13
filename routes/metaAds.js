"use strict";

const express         = require("express");
const router          = express.Router();
const MetaAd          = require("../models/MetaAd");
const AdLead          = require("../models/AdLead");
const Client          = require("../models/Client");
const { verifyToken } = require("../middleware/auth");
const { syncMetaAds, getAdAccounts } = require("../utils/metaAdsAPI");
const { platformGenerateJSON } = require("../utils/gemini"); // ✅ Phase R4: Use platform key wrapper

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

// ─── POST /api/meta-ads/:clientId/analyze — Gemini AI analysis ──────────────
router.post("/:clientId/analyze", verifyToken, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const { adId } = req.body;
    const filter = { clientId: client._id };
    if (adId) filter.metaAdId = adId;

    const ads = await MetaAd.find(filter).sort({ updatedAt: -1 }).limit(10).lean();
    if (ads.length === 0) return res.status(404).json({ success: false, message: "No ads found to analyze" });

    // Build metrics snapshot for Gemini
    const metricsBlock = ads.map(a => ({
      name: a.adName,
      status: a.adStatus,
      ctr: a.insights?.ctr ?? 0,
      cpm: a.insights?.cpm ?? 0,
      spend: a.insights?.spend ?? 0,
      impressions: a.insights?.impressions ?? 0,
      clicks: a.insights?.clicks ?? 0,
      leadsCount: a.topedgeStats?.leadsCount ?? 0,
      revenue: a.topedgeStats?.revenue ?? 0,
      roiPercent: a.topedgeStats?.roiPercent ?? 0,
      cpl: a.topedgeStats?.leadsCount > 0 ? (a.insights?.spend / a.topedgeStats.leadsCount).toFixed(2) : 0,
    }));

    const prompt = `You are a world-class Meta Ads conversion engineer for an Indian D2C brand.
Analyze these ad metrics for ${client.name || 'this brand'} and provide 4 surgical, data-backed suggestions.

Focus on:
1. "Creative Fatigue": High CPM or low CTR.
2. "Middle-Funnel Leak": High CTR but low LeadsCount.
3. "ROAS Optimization": Scaling best ROI ads and killing the losers.
4. "Conversion Bitrate": Leads per 1000 impressions.

Metrics (Top 10 Ads):
${JSON.stringify(metricsBlock, null, 2)}

Return ONLY a JSON array with this schema:
[{ "title": string, "suggestion": string, "priority": "high"|"medium"|"low", "metric": "CTR"|"CPL"|"ROI"|"CPM", "impact": string }]`;

    // ✅ Phase R4: Use platformGenerateJSON (correct model, correct key, no crash)
    let suggestions = [];
    const parsed = await platformGenerateJSON(prompt, { temperature: 0.3 });
    if (parsed && Array.isArray(parsed)) {
      suggestions = parsed;
    } else {
      suggestions = [{ 
        title: "Intelligence Ready", 
        suggestion: "Your ads are being analyzed. High-level observation: Your average CPL is ₹" + (metricsBlock.reduce((s, m) => s + Number(m.cpl), 0) / metricsBlock.length).toFixed(2), 
        priority: "medium", 
        metric: "CPL",
        impact: "Medium"
      }];
    }

    return res.json({ success: true, suggestions, analyzedAds: ads.length }); // ✅ Phase R4: Single res.json() — removed duplicate
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
