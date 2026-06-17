'use strict';

const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const AdLead = require('../models/AdLead');
const Segment = require('../models/Segment');
const SuppressionList = require('../models/SuppressionList');
const { resolveImportBatchObjectId } = require('../utils/core/importBatchResolver');
const {
  normalizePhoneDigits,
  normalizeEmail,
  filterAudienceForMarketingOptIn,
  evaluateAudiencePolicySummary,
  audienceOptQueryForCampaign,
} = require('../utils/commerce/marketingConsent');

function normalizeAudienceRow(row) {
  if (!row || typeof row !== 'object') return null;
  const phone = normalizePhoneDigits(
    row.phone || row.phoneNumber || row.number || row.mobile || ''
  );
  const email = normalizeEmail(row.email);
  if (!phone && !email) return null;
  return { ...row, phone: phone || row.phone, email: email || row.email };
}

function detectSourceType(campaign) {
  if (Array.isArray(campaign.audience) && campaign.audience.length > 0) {
    if (campaign.csvFile) return 'csv';
    return 'frozen_list';
  }
  if (campaign.isSmartSend) return 'hot';
  if (campaign.segmentId) return 'segment';
  if (campaign.importBatchId) return 'imported';
  return 'unknown';
}

async function resolveHotLeadsAudience(campaign) {
  const optQ = audienceOptQueryForCampaign(campaign);
  const limit = Math.max(1, Number(campaign.audienceCount) || 50);
  const leads = await AdLead.find({
    clientId: campaign.clientId,
    leadScore: { $gte: 60 },
    phoneNumber: { $exists: true, $ne: '' },
    ...optQ,
  })
    .sort({ leadScore: -1 })
    .limit(limit)
    .select('phoneNumber email name optStatus optInSource')
    .lean();
  return leads.map((l) => ({
    phone: l.phoneNumber,
    email: l.email || '',
    name: l.name || 'Customer',
    _id: l._id,
    optStatus: l.optStatus,
    optInSource: l.optInSource,
  }));
}

/**
 * Resolve audience rows for a campaign document (CSV frozen list, segment, import, hot).
 */
async function resolveCampaignAudienceRows(campaign) {
  if (!campaign) return { sourceType: 'unknown', rows: [] };

  const sourceType = detectSourceType(campaign);
  let rows = [];

  if (Array.isArray(campaign.audience) && campaign.audience.length > 0) {
    rows = campaign.audience.map(normalizeAudienceRow).filter(Boolean);
  } else if (campaign.isSmartSend) {
    rows = await resolveHotLeadsAudience(campaign);
  } else if (campaign.segmentId) {
    const segment = await Segment.findOne({
      _id: campaign.segmentId,
      clientId: campaign.clientId,
    }).lean();
    if (segment) {
      const optQ = audienceOptQueryForCampaign(campaign);
      const leads = await AdLead.find({ clientId: campaign.clientId, ...segment.query, ...optQ })
        .select('phoneNumber email name optStatus optInSource')
        .lean();
      rows = leads.map((l) => ({
        phone: l.phoneNumber,
        email: l.email || '',
        name: l.name || 'Customer',
        _id: l._id,
        optStatus: l.optStatus,
        optInSource: l.optInSource,
      }));
    }
  } else if (campaign.importBatchId) {
    const resolvedBatchId = await resolveImportBatchObjectId(
      campaign.importBatchId,
      campaign.clientId
    );
    if (resolvedBatchId) {
      const optQ = audienceOptQueryForCampaign(campaign);
      const leads = await AdLead.find({
        importBatchId: resolvedBatchId,
        clientId: campaign.clientId,
        ...optQ,
      })
        .select('phoneNumber email name optStatus optInSource')
        .lean();
      rows = leads.map((l) => ({
        phone: l.phoneNumber,
        email: l.email || '',
        name: l.name || 'Customer',
        _id: l._id,
        optStatus: l.optStatus,
        optInSource: l.optInSource,
      }));
    }
  }

  return { sourceType, rows };
}

async function buildCampaignAudienceSnapshot(campaign, { templateCategory = 'MARKETING' } = {}) {
  const { sourceType, rows: rawRows } = await resolveCampaignAudienceRows(campaign);
  const isEmail = String(campaign.channel || 'whatsapp').toLowerCase() === 'email';
  const cat = String(templateCategory || campaign.templateCategory || 'MARKETING').toUpperCase();

  const validRows = isEmail
    ? rawRows.filter((row) => Boolean(normalizeEmail(row?.email)))
    : rawRows.filter((row) =>
        Boolean(normalizePhoneDigits(row?.phone || row?.phoneNumber || ''))
      );

  const invalidPhone = Math.max(0, rawRows.length - validRows.length);

  const optFiltered = await filterAudienceForMarketingOptIn(
    campaign.clientId,
    validRows,
    campaign
  );

  const phoneSet = new Set();
  for (const row of validRows) {
    const p = normalizePhoneDigits(row?.phone || row?.phoneNumber || '');
    if (p) phoneSet.add(p);
  }

  let suppressedPhones = new Set();
  let leadByPhone = new Map();
  if (phoneSet.size > 0) {
    const [suppressedDocs, leads] = await Promise.all([
      SuppressionList.find({
        clientId: campaign.clientId,
        phone: { $in: [...phoneSet] },
      })
        .select('phone')
        .lean(),
      AdLead.find({
        clientId: campaign.clientId,
        phoneNumber: { $in: [...phoneSet] },
      })
        .select('phoneNumber optStatus optInSource')
        .lean(),
    ]);
    suppressedPhones = new Set(suppressedDocs.map((d) => d.phone));
    leadByPhone = new Map(leads.map((l) => [l.phoneNumber, l]));
  }

  let willSend = 0;
  let optedOut = 0;
  let suppressed = 0;
  const willSendRows = [];

  for (const row of optFiltered.rows) {
    const p = normalizePhoneDigits(row?.phone || row?.phoneNumber || '');
    if (!p) continue;
    if (suppressedPhones.has(p)) {
      suppressed += 1;
      continue;
    }
    const lead = leadByPhone.get(p);
    const status = String(lead?.optStatus || row?.optStatus || 'unknown').toLowerCase();
    if (status === 'opted_out') {
      optedOut += 1;
      continue;
    }
    willSend += 1;
    willSendRows.push(row);
  }

  const policy = evaluateAudiencePolicySummary(
    willSendRows.map((row) => ({
      optStatus: row.optStatus || leadByPhone.get(normalizePhoneDigits(row?.phone || ''))?.optStatus || 'unknown',
      optInSource: row.optInSource,
    })),
    cat
  );

  const sourceMap = new Map();
  for (const row of validRows) {
    const src = row.optInSource || 'unknown';
    sourceMap.set(src, (sourceMap.get(src) || 0) + 1);
  }

  return {
    success: true,
    campaignId: String(campaign._id),
    sourceType,
    templateCategory: cat,
    total: validRows.length,
    willSend,
    optedOut,
    suppressed,
    invalidPhone,
    unknownBlocked: Math.max(0, validRows.length - willSend - optedOut - suppressed),
    bySource: [...sourceMap.entries()].map(([source, count]) => ({ source, count })),
    recommendedRepermission: policy.unknownBlocked > 0 ? policy.unknownBlocked : 0,
    audienceCount: campaign.audienceCount ?? validRows.length,
  };
}

async function getCampaignAudienceSnapshot(clientId, campaignId, options = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(campaignId))) {
    const err = new Error('Invalid campaign id');
    err.status = 400;
    throw err;
  }
  const campaign = await Campaign.findOne({ _id: campaignId, clientId }).lean();
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  return buildCampaignAudienceSnapshot(campaign, options);
}

module.exports = {
  detectSourceType,
  resolveCampaignAudienceRows,
  buildCampaignAudienceSnapshot,
  getCampaignAudienceSnapshot,
};
