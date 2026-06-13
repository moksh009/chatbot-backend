'use strict';

const CampaignMessage = require('../../models/CampaignMessage');
const { estimateCostInr } = require('../../constants/metaWhatsAppPricing');

const BILLABLE_STATUSES = ['sent', 'delivered', 'read', 'replied'];

function billableSentCount(statusMap = {}) {
  return BILLABLE_STATUSES.reduce((sum, s) => sum + (Number(statusMap[s]) || 0), 0);
}

/**
 * @param {string} clientId
 * @param {import('mongoose').Types.ObjectId[]} campaignIds
 * @returns {Promise<Map<string, Record<string, number>>>}
 */
async function aggregateCampaignStatsById(clientId, campaignIds) {
  const map = new Map();
  if (!clientId || !campaignIds?.length) return map;

  const rows = await CampaignMessage.aggregate([
    { $match: { clientId, campaignId: { $in: campaignIds } } },
    { $group: { _id: { campaignId: '$campaignId', status: '$status' }, count: { $sum: 1 } } },
  ]).option({ maxTimeMS: 8000 });

  for (const row of rows) {
    const cid = String(row._id.campaignId);
    if (!map.has(cid)) map.set(cid, {});
    map.get(cid)[row._id.status] = row.count;
  }
  return map;
}

function resolveTemplateCategory(campaign = {}) {
  if (campaign.campaignType === 'RE_PERMISSION') return 'UTILITY';
  return String(campaign.templateCategory || 'MARKETING').toUpperCase();
}

function enrichCampaignRow(campaign, statusMap = {}) {
  const sentFromMessages = billableSentCount(statusMap);
  const sent = sentFromMessages > 0 ? sentFromMessages : Number(campaign.sentCount || 0);
  const readFromMessages = (Number(statusMap.read) || 0) + (Number(statusMap.replied) || 0);
  const readCount =
    readFromMessages > 0 ? readFromMessages : Number(campaign.readCount || 0);
  const repliedCount =
    Number(statusMap.replied) > 0
      ? Number(statusMap.replied)
      : Number(campaign.repliedCount || 0);
  const deliveredBase =
    (Number(statusMap.delivered) || 0) + readCount || Number(campaign.deliveredCount || 0) + readCount;
  const readRate =
    deliveredBase > 0
      ? Math.round((readCount / deliveredBase) * 100)
      : sent > 0
        ? Math.round((readCount / sent) * 100)
        : 0;
  const replyRate = sent > 0 ? Math.round((repliedCount / sent) * 100) : 0;
  const category = resolveTemplateCategory(campaign);
  const billingInr = estimateCostInr(category, sent);
  const buttonClicks = Number(campaign.buttonClicks || 0);
  const linkClicks = Number(campaign.websiteClicks || 0);
  const clickRate =
    sent > 0 ? Math.round(((buttonClicks + linkClicks) / sent) * 100) : 0;
  const revenue = Number(campaign.revenueAttributed || 0);

  return {
    ...campaign,
    sentCount: sent,
    readCount,
    repliedCount,
    readRate,
    replyRate,
    revenue,
    revenueAttributed: revenue,
    billingInr,
    billingCategory: category,
    buttonClicks,
    linkClicks,
    clickRate,
  };
}

module.exports = {
  BILLABLE_STATUSES,
  billableSentCount,
  aggregateCampaignStatsById,
  enrichCampaignRow,
  resolveTemplateCategory,
};
