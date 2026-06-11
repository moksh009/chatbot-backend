'use strict';

const TemplateSendLog = require('../../models/TemplateSendLog');
const CampaignMessage = require('../../models/CampaignMessage');
const DeadLetterWebhook = require('../../models/DeadLetterWebhook');
const Client = require('../../models/Client');
const { getCronHealth } = require('../messagingActivityService');

async function getFailedTemplateSendLogs(clientId, { since, limit = 30, page = 1 } = {}) {
  const match = {
    clientId,
    sentAt: { $gte: since },
    failureCode: { $nin: ['sent', null] },
  };
  const skip = Math.max(0, (Number(page) - 1) * Number(limit));
  const [rows, total] = await Promise.all([
    TemplateSendLog.find(match)
      .sort({ sentAt: -1 })
      .skip(skip)
      .limit(Math.min(Number(limit) || 30, 100))
      .select(
        'templateName contextType automationSlotId recipientPhone failureCode status errorMessage sentAt'
      )
      .lean(),
    TemplateSendLog.countDocuments(match).maxTimeMS(8000),
  ]);
  return { rows, total, page: Number(page) || 1, limit: Number(limit) || 30 };
}

async function getClientReliabilityDetail(clientId, { days = 7 } = {}) {
  const windowDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  const client = await Client.findOne({ clientId })
    .select('clientId businessName shopDomain phoneNumberId whatsappConnectedAt shopifyDomain')
    .lean();

  const [
    templateFailed,
    templateSent,
    campaignFailed,
    deadLetters,
    recentCampaignFailures,
    sendLogPage,
    cronHealth,
  ] = await Promise.all([
    TemplateSendLog.countDocuments({
      clientId,
      sentAt: { $gte: since },
      failureCode: { $nin: ['sent', null] },
    }).maxTimeMS(8000),
    TemplateSendLog.countDocuments({
      clientId,
      sentAt: { $gte: since },
      failureCode: 'sent',
    }).maxTimeMS(8000),
    CampaignMessage.countDocuments({
      clientId,
      status: 'failed',
      $or: [{ failedAt: { $gte: since } }, { lastAttemptAt: { $gte: since } }],
    }).maxTimeMS(8000),
    DeadLetterWebhook.countDocuments({ clientId, deadLetteredAt: { $gte: since } }).maxTimeMS(8000),
    CampaignMessage.find({
      clientId,
      status: 'failed',
    })
      .sort({ failedAt: -1, lastAttemptAt: -1 })
      .limit(15)
      .select('phone campaignId failureReason errorMessage failedAt lastAttemptAt')
      .lean(),
    getFailedTemplateSendLogs(clientId, { since, limit: 25, page: 1 }),
    getCronHealth(),
  ]);

  return {
    clientId,
    businessName: client?.businessName || clientId,
    shopifyDomain: client?.shopifyDomain || null,
    whatsappConnected: !!(client?.whatsappConnectedAt || client?.phoneNumberId),
    days: windowDays,
    counts: {
      templateSendFailed: templateFailed,
      templateSendOk: templateSent,
      campaignMessageFailed: campaignFailed,
      deadLetterWebhooks: deadLetters,
    },
    cronHealth,
    recentCampaignFailures: recentCampaignFailures.map((row) => ({
      phone: row.phone,
      campaignId: row.campaignId,
      reason: row.failureReason || row.errorMessage || 'failed',
      at: row.failedAt || row.lastAttemptAt,
    })),
    recentTemplateFailures: sendLogPage.rows,
    sendLog: sendLogPage,
  };
}

async function getPlatformReliabilitySummary({ days = 7, limit = 50 } = {}) {
  const windowDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
  const cronHealth = await getCronHealth();

  const templateAgg = await TemplateSendLog.aggregate([
    {
      $match: {
        sentAt: { $gte: since },
        failureCode: { $nin: ['sent', null] },
      },
    },
    {
      $group: {
        _id: '$clientId',
        templateFailures: { $sum: 1 },
        lastFailureAt: { $max: '$sentAt' },
        lastMessage: { $last: '$errorMessage' },
      },
    },
    { $sort: { templateFailures: -1 } },
    { $limit: Math.min(Number(limit) || 50, 200) },
  ]);

  const campaignAgg = await CampaignMessage.aggregate([
    {
      $match: {
        status: 'failed',
        $or: [{ failedAt: { $gte: since } }, { lastAttemptAt: { $gte: since } }],
      },
    },
    {
      $group: {
        _id: '$clientId',
        campaignFailures: { $sum: 1 },
        lastFailureAt: { $max: '$failedAt' },
      },
    },
  ]);

  const dlAgg = await DeadLetterWebhook.aggregate([
    { $match: { deadLetteredAt: { $gte: since } } },
    { $group: { _id: '$clientId', deadLetters: { $sum: 1 } } },
  ]);

  const byClient = new Map();
  for (const row of templateAgg) {
    byClient.set(row._id, {
      clientId: row._id,
      templateFailures: row.templateFailures,
      campaignFailures: 0,
      deadLetters: 0,
      lastFailureAt: row.lastFailureAt,
      lastMessage: row.lastMessage,
    });
  }
  for (const row of campaignAgg) {
    const cur = byClient.get(row._id) || {
      clientId: row._id,
      templateFailures: 0,
      campaignFailures: 0,
      deadLetters: 0,
      lastFailureAt: null,
      lastMessage: null,
    };
    cur.campaignFailures = row.campaignFailures;
    if (!cur.lastFailureAt || (row.lastFailureAt && row.lastFailureAt > cur.lastFailureAt)) {
      cur.lastFailureAt = row.lastFailureAt;
    }
    byClient.set(row._id, cur);
  }
  for (const row of dlAgg) {
    const cur = byClient.get(row._id) || {
      clientId: row._id,
      templateFailures: 0,
      campaignFailures: 0,
      deadLetters: 0,
      lastFailureAt: null,
      lastMessage: null,
    };
    cur.deadLetters = row.deadLetters;
    byClient.set(row._id, cur);
  }

  const rows = [...byClient.values()]
    .map((r) => ({
      ...r,
      totalIssues: r.templateFailures + r.campaignFailures + r.deadLetters,
    }))
    .filter((r) => r.totalIssues > 0)
    .sort((a, b) => b.totalIssues - a.totalIssues)
    .slice(0, Math.min(Number(limit) || 50, 200));

  const clientIds = rows.map((r) => r.clientId);
  const clients = await Client.find({ clientId: { $in: clientIds } })
    .select('clientId businessName')
    .lean();
  const nameMap = Object.fromEntries(clients.map((c) => [c.clientId, c.businessName]));

  return {
    days: windowDays,
    cronHealth,
    rows: rows.map((r) => ({
      ...r,
      businessName: nameMap[r.clientId] || r.clientId,
      cronStale: !!cronHealth?.stale,
    })),
  };
}

module.exports = {
  getClientReliabilityDetail,
  getPlatformReliabilitySummary,
  getFailedTemplateSendLogs,
};
