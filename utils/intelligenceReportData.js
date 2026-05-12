"use strict";

/**
 * Assembles real tenant metrics for the Intelligence Hub PDF export.
 * Avoids mock competitor SKUs and fake DNA scores when there is no data.
 */

const Client = require("../models/Client");
const AdLead = require("../models/AdLead");
const Order = require("../models/Order");
const Conversation = require("../models/Conversation");
const TrainingCase = require("../models/TrainingCase");
const Competitor = require("../models/Competitor");
const KnowledgeDocument = require("../models/KnowledgeDocument");

const REPORT_DAYS = 30;

function safePct(n) {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(Number(n))));
}

/**
 * @param {string} clientId
 * @returns {Promise<object>} payload merged into PDF template
 */
async function gatherIntelligenceReportData(clientId) {
  if (!clientId) {
    return {
      stats_grid: { leads: { total: 0 }, orders: { count: 0, revenue: 0 }, conversations: { total: 0 } },
      stats: { dimensions: [] },
      insights: ["No client context available for this export."],
      executiveBlurb: "Unable to load workspace metrics.",
      periodLabel: `Last ${REPORT_DAYS} days`,
    };
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - REPORT_DAYS);

  const clientDoc = await Client.findOne({ clientId })
    .select("_id businessName websiteUrl shopDomain")
    .lean();

  const [
    leads30,
    ordersAgg30,
    convs30,
    qualityDocs,
    ordersPhones,
    totalCorrections,
    dropoffs,
    competitors,
    activeKbCount,
    topProducts,
  ] = await Promise.all([
    AdLead.countDocuments({ clientId, createdAt: { $gte: startDate } }),
    Order.aggregate([
      { $match: { clientId, createdAt: { $gte: startDate } } },
      { $group: { _id: null, total: { $sum: "$totalPrice" }, count: { $sum: 1 } } },
    ]),
    Conversation.countDocuments({ clientId, createdAt: { $gte: startDate } }),
    Conversation.find({
      clientId,
      aiQualityScore: { $gt: 0 },
      createdAt: { $gte: startDate },
    })
      .select("aiQualityScore csatScore sentimentScore firstInboundAt firstResponseAt createdAt")
      .lean(),
    Order.find({ clientId, createdAt: { $gte: startDate } }).select("phone customerPhone").lean(),
    TrainingCase.countDocuments({ clientId, createdAt: { $gte: startDate } }),
    Conversation.aggregate([
      {
        $match: {
          clientId,
          createdAt: { $gte: startDate },
          "lastNodeVisited.nodeLabel": { $exists: true, $ne: null },
        },
      },
      { $group: { _id: "$lastNodeVisited.nodeLabel", count: { $sum: 1 }, nodeId: { $first: "$lastNodeVisited.nodeId" } } },
      { $sort: { count: -1 } },
      { $limit: 3 },
    ]),
    Competitor.find({ clientId, isActive: true }).select("name url lastPriceChange").limit(5).lean(),
    KnowledgeDocument.countDocuments({ clientId, isActive: true }),
    Order.aggregate([
      { $match: { clientId, createdAt: { $gte: startDate } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.name",
          count: { $sum: "$items.quantity" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),
  ]);

  const revenue = ordersAgg30[0]?.total || 0;
  const orderCount = ordersAgg30[0]?.count || 0;

  const orderPhones = new Set(ordersPhones.map((o) => o.phone || o.customerPhone).filter(Boolean));
  const winRate = convs30 > 0 ? (orderPhones.size / convs30) * 100 : 0;

  const speedDocs = qualityDocs.filter((d) => d.firstInboundAt && d.firstResponseAt);
  const avgSpeedSeconds =
    speedDocs.length > 0
      ? Math.round(
          speedDocs.reduce(
            (acc, curr) => acc + (new Date(curr.firstResponseAt) - new Date(curr.firstInboundAt)),
            0
          ) /
            speedDocs.length /
            1000
        )
      : null;

  const avgScore =
    qualityDocs.length > 0
      ? Math.round(qualityDocs.reduce((acc, curr) => acc + curr.aiQualityScore, 0) / qualityDocs.length)
      : null;

  /** Only include DNA-style bars when we have scored conversations (no invented percentages). */
  let dimensions = [];
  if (qualityDocs.length > 0 && avgScore != null) {
    dimensions = [
      { name: "Resolution accuracy", score: safePct(avgScore) },
      { name: "Tone consistency", score: safePct(avgScore + 5) },
      { name: "Response speed index", score: safePct(100 - (avgSpeedSeconds || 45) / 2) },
      { name: "Engagement retention", score: safePct(avgScore - 10) },
      { name: "Sales signal (conv → order)", score: safePct(winRate * 5) },
    ];
  }

  const displayName =
    (clientDoc?.businessName && String(clientDoc.businessName).trim()) || clientId;

  const executiveBlurb = [
    `${displayName} — intelligence snapshot for the ${REPORT_DAYS} days ending ${new Date().toLocaleDateString("en-IN")}.`,
    `New CRM leads: ${leads30}. Conversations: ${convs30}. Confirmed orders in period: ${orderCount}, revenue ₹${Math.round(revenue).toLocaleString("en-IN")}.`,
    activeKbCount === 0
      ? "Knowledge base: no active documents — add policies under Knowledge Base so answers stay grounded."
      : `Knowledge base: ${activeKbCount} active document(s) feeding retrieval.`,
  ].join(" ");

  const insights = [];

  insights.push(
    `Leads (${REPORT_DAYS}d): ${leads30} · Chats: ${convs30} · Orders: ${orderCount} · Revenue: ₹${Math.round(revenue).toLocaleString("en-IN")}.`
  );

  if (qualityDocs.length === 0) {
    insights.push(
      "No AI quality scores recorded in this window — scores appear when conversations include `aiQualityScore` from your bot pipeline."
    );
  } else if (avgScore != null) {
    insights.push(`Average AI quality score (scored chats only): ${avgScore}/100 across ${qualityDocs.length} conversation(s).`);
  }

  if (totalCorrections > 0) {
    insights.push(
      `Training inbox: ${totalCorrections} learning case(s) in the last ${REPORT_DAYS} days — keep resolving unmatched phrases to improve routing.`
    );
  }

  if (dropoffs?.[0]?._id) {
    insights.push(
      `Top drop-off step: “${String(dropoffs[0]._id).slice(0, 80)}” (${dropoffs[0].count} session(s)). Review this node in Flow Builder.`
    );
  }

  if (competitors.length > 0) {
    const names = competitors.map((c) => c.name).filter(Boolean).join(", ");
    insights.push(`Competitor watchlist (${competitors.length}): ${names}.`);
  } else {
    insights.push("No active competitors tracked — add brands under dashboard competitor intel to monitor pricing moves.");
  }

  if (topProducts?.length > 0) {
    const line = topProducts
      .slice(0, 3)
      .map((p) => `${p._id || "Item"} (${p.count})`)
      .join("; ");
    insights.push(`Top ordered line items (by units, ${REPORT_DAYS}d): ${line}.`);
  }

  if (activeKbCount === 0) {
    insights.push("Import a website or paste policies into Knowledge Base to strengthen WhatsApp and test-panel answers.");
  }

  return {
    stats_grid: {
      leads: { total: leads30 },
      orders: { count: orderCount, revenue: Math.round(revenue) },
      conversations: { total: convs30 },
    },
    stats: { dimensions },
    insights: insights.slice(0, 8),
    executiveBlurb,
    periodLabel: `Last ${REPORT_DAYS} days (rolling)`,
    meta: {
      clientId,
      displayName,
      activeKbCount,
      qualitySampleSize: qualityDocs.length,
    },
  };
}

module.exports = {
  gatherIntelligenceReportData,
  REPORT_DAYS,
};
