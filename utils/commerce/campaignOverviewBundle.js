'use strict';

const Client = require('../../models/Client');
const Campaign = require('../../models/Campaign');
const CampaignMessage = require('../../models/CampaignMessage');
const WhatsApp = require('../meta/whatsapp');
const log = require('../core/logger')('CampaignOverview');

const META_HEALTH_TIMEOUT_MS = 4500;
const OVERVIEW_AGG_MAX_MS = 12_000;

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

function isThrottledWhatsApp(clientDoc) {
  const until = clientDoc?.complianceConfig?.rateLimits?.whatsapp?.throttledUntil;
  return !!(until && new Date(until) > new Date());
}

async function fetchMetaHealthForOverview(client) {
  const fallback = {
    status: 'HEALTHY',
    tier: 'Tier 1 (1k/day)',
    qualityRating: 'GREEN',
    lastTemplateUpdate: new Date(),
  };
  if (!client?.whatsappToken || !(client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID)) {
    return fallback;
  }
  try {
    const [acc, qual] = await withTimeout(
      Promise.all([WhatsApp.getAccountStatus(client), WhatsApp.getPhoneNumberQuality(client)]),
      META_HEALTH_TIMEOUT_MS,
      null
    );
    if (!acc || !qual) return { ...fallback, status: 'UNKNOWN', qualityRating: 'UNKNOWN' };
    return {
      status: acc.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : qual.status || 'HEALTHY',
      tier: qual.tier || 'Tier 1 (1k/day)',
      qualityRating: qual.qualityRating || 'GREEN',
      lastTemplateUpdate: new Date(),
    };
  } catch (healthErr) {
    log.warn(`[CampaignOverview] Meta health timeout/error for ${client.clientId}: ${healthErr.message}`);
    return { ...fallback, status: 'UNKNOWN' };
  }
}

/** GET /campaigns/:clientId/overview (full mode) payload for analytics workspace bundle. */
async function buildCampaignOverviewFullPayload(clientId, days = 30) {
  const rawDays = parseInt(days, 10);
  const periodDays =
    rawDays === 999 ? 90 : Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 90) : null;
  const periodSince = periodDays ? new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000) : null;
  const messageMatch = { clientId };
  if (periodSince) messageMatch.sentAt = { $gte: periodSince };

  const clientDoc = await Client.findOne({ clientId })
    .select('complianceConfig whatsappToken phoneNumberId wabaId plan subscriptionPlan')
    .lean();

  const throttledWhatsApp = isThrottledWhatsApp(clientDoc);

  const [campaigns, statsArray, activeCampaigns, billingByCategory] = await Promise.all([
    Campaign.find(periodSince ? { clientId, createdAt: { $gte: periodSince } } : { clientId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()
      .maxTimeMS(8000),
    CampaignMessage.aggregate([
      { $match: messageMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).option({ maxTimeMS: OVERVIEW_AGG_MAX_MS }),
    Campaign.countDocuments({ clientId, status: 'SENDING' }).maxTimeMS(4000),
    CampaignMessage.aggregate([
      { $match: { ...messageMatch, status: { $in: ['sent', 'delivered', 'read', 'replied'] } } },
      {
        $lookup: {
          from: 'campaigns',
          localField: 'campaignId',
          foreignField: '_id',
          as: 'camp',
        },
      },
      { $unwind: '$camp' },
      {
        $group: {
          _id: { $ifNull: ['$camp.templateCategory', 'MARKETING'] },
          count: { $sum: 1 },
        },
      },
    ]).option({ maxTimeMS: OVERVIEW_AGG_MAX_MS }),
  ]);

  const statsMap = statsArray.reduce((acc, curr) => {
    acc[curr._id] = curr.count;
    return acc;
  }, {});

  const totalDelivered = (statsMap.delivered || 0) + (statsMap.read || 0) + (statsMap.replied || 0);
  const totalSent = (statsMap.sent || 0) + totalDelivered;
  const totalRead = (statsMap.read || 0) + (statsMap.replied || 0);
  const totalReplied = statsMap.replied || 0;
  const totalFailed = statsMap.failed || 0;
  const totalCancelled = statsMap.cancelled || 0;

  const deliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0;
  const readRate = totalDelivered > 0 ? Math.round((totalRead / totalDelivered) * 100) : 0;
  const replyRate = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;

  const { estimateMetaBreakdown } = require('../../services/billing/costEstimation');
  const { normalizeCategory } = require('../../constants/metaWhatsAppPricing');
  const {
    aggregateCampaignStatsById,
    enrichCampaignRow,
  } = require('../commerce/campaignOverviewMetrics');

  let marketingCount = 0;
  let utilityCount = 0;
  for (const row of billingByCategory || []) {
    const cat = normalizeCategory(row._id);
    const count = Number(row.count) || 0;
    if (cat === 'UTILITY' || cat === 'AUTHENTICATION') utilityCount += count;
    else marketingCount += count;
  }
  const billingBreakdown = estimateMetaBreakdown({ marketingCount, utilityCount });

  const campaignIds = campaigns.map((c) => c._id);
  const perCampaignStats = await aggregateCampaignStatsById(clientId, campaignIds);

  const totalRevenue = campaigns.reduce((sum, c) => sum + Number(c.revenueAttributed || 0), 0);
  const totalButtonClicks = campaigns.reduce((sum, c) => sum + Number(c.buttonClicks || 0), 0);
  const totalLinkClicks = campaigns.reduce((sum, c) => sum + Number(c.websiteClicks || 0), 0);

  const recentCampaigns = campaigns
    .slice(0, 10)
    .map((c) => enrichCampaignRow(c, perCampaignStats.get(String(c._id)) || {}));

  const metaHealth = await fetchMetaHealthForOverview(clientDoc);

  return {
    success: true,
    stats: {
      totalSent,
      totalDelivered,
      totalRead,
      totalReplied,
      totalFailed,
      totalCancelled,
      deliveryRate,
      readRate,
      replyRate,
      totalRevenue,
      totalBillingInr: billingBreakdown.meta_subtotal_inr,
      totalButtonClicks,
      totalLinkClicks,
      billingBreakdown,
    },
    metaHealth,
    activeCampaigns,
    throttledWhatsApp,
    recentCampaigns,
  };
}

module.exports = {
  buildCampaignOverviewFullPayload,
  isThrottledWhatsApp,
  fetchMetaHealthForOverview,
};
