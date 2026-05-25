'use strict';

const moment = require('moment');
const Client = require('../../models/Client');
const Campaign = require('../../models/Campaign');
const FollowUpSequence = require('../../models/FollowUpSequence');

function relTime(date) {
  if (!date) return null;
  return moment(date).fromNow();
}

async function buildMarketingHubHealth(clientId) {
  const client = await Client.findOne({ clientId })
    .select('whatsappToken phoneNumberId wabaId syncedMetaTemplates templatesSyncedAt')
    .lean();

  const waConnected = !!(client?.whatsappToken && client?.phoneNumberId);
  const synced = Array.isArray(client?.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  const approvedTemplates = synced.filter((t) => String(t?.status || '').toUpperCase() === 'APPROVED').length;

  const [campaignCounts, activeSequences, recentCampaign] = await Promise.all([
    Campaign.aggregate([
      { $match: { clientId } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    FollowUpSequence.countDocuments({ clientId, status: 'active' }),
    Campaign.findOne({ clientId }).sort({ updatedAt: -1 }).select('status updatedAt name').lean(),
  ]);

  const byStatus = {};
  for (const row of campaignCounts) {
    byStatus[String(row._id || 'unknown').toLowerCase()] = row.n;
  }

  const sending = (byStatus.sending || 0) + (byStatus.scheduled || 0);
  const completed = byStatus.completed || byStatus.sent || 0;
  const draft = byStatus.draft || 0;

  return {
    whatsapp: {
      connected: waConnected,
      templatesApproved: approvedTemplates,
      templatesSyncedAt: client?.templatesSyncedAt || null,
      templatesSyncedLabel: relTime(client?.templatesSyncedAt),
    },
    campaigns: {
      sending,
      completed,
      draft,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      lastLabel: relTime(recentCampaign?.updatedAt),
      lastStatus: recentCampaign?.status || null,
    },
    sequences: {
      active: activeSequences,
    },
  };
}

module.exports = { buildMarketingHubHealth };
