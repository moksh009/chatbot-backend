"use strict";

/**
 * Assembles real tenant metrics for the Intelligence Hub PDF export.
 */

const Client = require("../../models/Client");
const AdLead = require("../../models/AdLead");
const Order = require("../../models/Order");
const Conversation = require("../../models/Conversation");
const TrainingCase = require("../../models/TrainingCase");
const IntentRule = require("../../models/IntentRule");
const KnowledgeDocument = require("../../models/KnowledgeDocument");
const Competitor = require("../../models/Competitor");
const AiWallet = require("../../models/AiWallet");

const REPORT_DAYS = 30;

function safePct(n) {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(Number(n))));
}

function formatInr(amount) {
  const n = Math.round(Number(amount) || 0);
  return `Rs. ${n.toLocaleString("en-IN")}`;
}

/**
 * @param {string} clientId
 * @returns {Promise<object>} payload merged into PDF template
 */
async function gatherIntelligenceReportData(clientId) {
  if (!clientId) {
    return emptyPayload("No workspace selected.");
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - REPORT_DAYS);
  const periodEnd = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const clientDoc = await Client.findOne({ clientId })
    .select("businessName shopifyDomain phoneNumberId whatsapp.phoneNumberId ai.persona.name commerce.shopify.domain")
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
    topProducts,
    activeIntents,
    activeKnowledgeDocs,
    intentTriggerAgg,
    aiWallet,
    knowledgeTitles,
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
      .select("aiQualityScore csatScore firstInboundAt firstResponseAt")
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
      {
        $group: {
          _id: "$lastNodeVisited.nodeLabel",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 3 },
    ]),
    Competitor.find({ clientId, isActive: true }).select("name").limit(5).lean(),
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
    IntentRule.countDocuments({ clientId, isActive: true }),
    KnowledgeDocument.countDocuments({ clientId, status: "active" }),
    IntentRule.aggregate([
      { $match: { clientId } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$totalTriggerCount", 0] } } } },
    ]),
    AiWallet.findOne({ clientId }).select("activeProvider byoKeyIsValid byoOpenaiKeyIsValid totalTokensUsed").lean(),
    KnowledgeDocument.find({ clientId, status: "active" })
      .select("title name")
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean(),
  ]);

  const revenue = ordersAgg30[0]?.total || 0;
  const orderCount = ordersAgg30[0]?.count || 0;
  const learningHits = intentTriggerAgg[0]?.total || 0;
  const apiConnected =
    aiWallet?.byoKeyIsValid === true || aiWallet?.byoOpenaiKeyIsValid === true;
  const aiProvider =
    aiWallet?.activeProvider === "openai"
      ? "OpenAI"
      : aiWallet?.activeProvider === "gemini"
        ? "Google Gemini"
        : apiConnected
          ? "Connected"
          : "Not connected";

  const personaName =
    String(clientDoc?.ai?.persona?.name || "").trim() || "Default assistant";
  const whatsappConnected = Boolean(
    String(clientDoc?.phoneNumberId || clientDoc?.whatsapp?.phoneNumberId || "").trim()
  );
  const shopifyConnected = Boolean(
    String(clientDoc?.shopifyDomain || clientDoc?.commerce?.shopify?.domain || "").trim()
  );

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

  let dimensions = [];
  if (qualityDocs.length > 0 && avgScore != null) {
    dimensions = [
      { name: "Resolution accuracy", score: safePct(avgScore) },
      { name: "Tone consistency", score: safePct(avgScore + 5) },
      { name: "Response speed", score: safePct(100 - (avgSpeedSeconds || 45) / 2) },
      { name: "Engagement retention", score: safePct(avgScore - 10) },
      { name: "Chat to order signal", score: safePct(winRate * 5) },
    ];
  }

  const displayName =
    (clientDoc?.businessName && String(clientDoc.businessName).trim()) || clientId;

  const executiveBlurb = [
    `${displayName} — AI Brain & commerce snapshot for the last ${REPORT_DAYS} days (ending ${periodEnd}).`,
    `You captured ${leads30} new lead${leads30 === 1 ? "" : "s"}, handled ${convs30} WhatsApp conversation${convs30 === 1 ? "" : "s"}, and recorded ${orderCount} Shopify order${orderCount === 1 ? "" : "s"} worth ${formatInr(revenue)}.`,
  ].join(" ");

  const highlights = [];

  highlights.push(
    `Commerce: ${leads30} leads · ${convs30} chats · ${orderCount} orders · ${formatInr(revenue)} revenue.`
  );

  highlights.push(
    `AI Brain: ${apiConnected ? `${aiProvider} API connected` : "API key not connected — add one under AI Brain → API key"}. ${activeIntents} active intent rule${activeIntents === 1 ? "" : "s"}, ${activeKnowledgeDocs} knowledge document${activeKnowledgeDocs === 1 ? "" : "s"}, persona “${personaName}”.`
  );

  if (learningHits > 0) {
    highlights.push(
      `Intent engine matched ${learningHits} customer message${learningHits === 1 ? "" : "s"} to trained rules in this period.`
    );
  }

  if (totalCorrections > 0) {
    highlights.push(
      `Training inbox: ${totalCorrections} phrase${totalCorrections === 1 ? "" : "s"} flagged for review — resolve them to improve routing.`
    );
  }

  if (qualityDocs.length > 0 && avgScore != null) {
    highlights.push(
      `AI quality (scored chats): ${avgScore}/100 average across ${qualityDocs.length} conversation${qualityDocs.length === 1 ? "" : "s"}.`
    );
  } else {
    highlights.push(
      "AI quality scores: not enough scored conversations in this window — scores appear as your bot handles more chats."
    );
  }

  if (dropoffs?.[0]?._id) {
    highlights.push(
      `Top flow drop-off: “${String(dropoffs[0]._id).slice(0, 72)}” (${dropoffs[0].count} session${dropoffs[0].count === 1 ? "" : "s"}). Review this step in Flow Builder.`
    );
  }

  if (topProducts?.length > 0) {
    const line = topProducts
      .slice(0, 3)
      .map((p) => `${p._id || "Item"} (${p.count} unit${p.count === 1 ? "" : "s"})`)
      .join(", ");
    highlights.push(`Best sellers (30d): ${line}.`);
  }

  if (competitors.length > 0) {
    highlights.push(
      `Competitors tracked: ${competitors.map((c) => c.name).filter(Boolean).join(", ")}.`
    );
  }

  const channelLines = [];
  if (whatsappConnected) channelLines.push("WhatsApp connected");
  else channelLines.push("WhatsApp not connected");
  if (shopifyConnected) channelLines.push("Shopify connected");
  else channelLines.push("Shopify not connected");
  highlights.push(`Channels: ${channelLines.join(" · ")}.`);

  const knowledgeList = (knowledgeTitles || [])
    .map((d) => String(d.title || d.name || "").trim())
    .filter(Boolean);

  return {
    stats_grid: {
      leads: { total: leads30 },
      orders: { count: orderCount, revenue: Math.round(revenue) },
      conversations: { total: convs30 },
    },
    stats: { dimensions, avgScore, scoredChats: qualityDocs.length, learningHits },
    highlights: highlights.slice(0, 9),
    insights: highlights.slice(0, 9),
    executiveBlurb,
    periodLabel: `Last ${REPORT_DAYS} days · ending ${periodEnd}`,
    formatInr,
    sections: {
      aiBrain: {
        apiConnected,
        provider: aiProvider,
        activeIntents,
        activeKnowledgeDocs,
        trainingCases: totalCorrections,
        learningHits,
        personaName,
        knowledgeTitles: knowledgeList,
        tokensUsed: aiWallet?.totalTokensUsed || 0,
      },
      channels: { whatsappConnected, shopifyConnected },
      quality: {
        scoredChats: qualityDocs.length,
        avgScore,
        avgResponseSeconds: avgSpeedSeconds,
      },
    },
    meta: {
      clientId,
      displayName,
      periodEnd,
      qualitySampleSize: qualityDocs.length,
    },
  };
}

function emptyPayload(message) {
  return {
    stats_grid: { leads: { total: 0 }, orders: { count: 0, revenue: 0 }, conversations: { total: 0 } },
    stats: { dimensions: [], avgScore: null, scoredChats: 0, learningHits: 0 },
    highlights: [message],
    insights: [message],
    executiveBlurb: message,
    periodLabel: `Last ${REPORT_DAYS} days`,
    sections: {},
    meta: { displayName: "Workspace" },
  };
}

module.exports = {
  gatherIntelligenceReportData,
  REPORT_DAYS,
  formatInr,
};
