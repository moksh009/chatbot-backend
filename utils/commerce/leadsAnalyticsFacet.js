'use strict';

const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const { normalizeLeadForDisplay } = require('./leadDisplayNormalize');
const { findOrdersForLead } = require('../customer360/leadLookupHelpers');
const { phoneVariants } = require('../messaging/cancelAllAutomationsFor');

const LEAD_LIST_PROJECTION = {
  name: 1,
  phoneNumber: 1,
  leadScore: 1,
  tags: 1,
  lastInteraction: 1,
  chatSummary: 1,
  cartStatus: 1,
  lastMessageContent: 1,
  lastInboundAt: 1,
  linkClicks: 1,
  email: 1,
  ordersCount: 1,
  totalSpent: 1,
  intentState: 1,
  addToCartCount: 1,
  meta: 1,
  createdAt: 1,
  pendingSupport: 1,
  lastPurchaseDate: 1,
  source: 1,
  adAttribution: 1,
  cartValue: 1,
  lifetimeValue: 1,
  checkoutInitiatedCount: 1,
  optInSource: 1,
  optStatus: 1,
  inboundMessageCount: 1,
  importBatchId: 1,
  isOrderPlaced: 1,
  channelConsent: 1,
  lastOrderAt: 1,
};

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyLeadScoreStage(query, stage) {
  const s = String(stage || '').toLowerCase();
  if (!s) return;
  const existing = query.leadScore && typeof query.leadScore === 'object' ? { ...query.leadScore } : {};
  if (s === 'hot') {
    query.leadScore = { ...existing, $gte: Math.max(existing.$gte ?? 0, 80) };
  } else if (s === 'warm') {
    query.leadScore = {
      ...existing,
      $gte: Math.max(existing.$gte ?? 0, 50),
      $lt: existing.$lt != null ? Math.min(existing.$lt, 80) : 80,
    };
  } else if (s === 'cold') {
    query.leadScore = { ...existing, $lt: existing.$lt != null ? Math.min(existing.$lt, 50) : 50 };
  }
}

function buildLeadsListQuery(
  clientId,
  { search, tag, segmentScore, lastSeen, importBatchId, optStatus, hasPhone, source, stage, engagement, convStatus }
) {
  const query = { clientId };
  if (importBatchId) {
    query.importBatchId = importBatchId;
  }
  if (optStatus) {
    const status = String(optStatus).trim().toLowerCase();
    if (['opted_in', 'opted_out', 'unknown', 'pending'].includes(status)) {
      query.optStatus = status;
    }
  }
  if (hasPhone === true || String(hasPhone).toLowerCase() === 'true') {
    query.phoneNumber = { $exists: true, $type: 'string', $regex: /\S/ };
  }
  if (search) {
    const searchRegex = new RegExp(search, 'i');
    query.$and = (query.$and || []).concat([
      { $or: [{ name: searchRegex }, { phoneNumber: searchRegex }, { email: searchRegex }] },
    ]);
  }
  if (tag) query.tags = tag;
  if (source) {
    const src = String(source).trim().toLowerCase();
    if (src === 'import' || src === 'csv_import') {
      query.$and = (query.$and || []).concat([
        {
          $or: [
            { source: { $regex: /^csv_import$/i } },
            { importBatchId: { $exists: true, $ne: null } },
          ],
        },
      ]);
    } else {
      query.source = { $regex: new RegExp(`^${escapeRegex(source)}$`, 'i') };
    }
  }
  if (segmentScore) {
    const [min, max] = segmentScore.split('-').map(Number);
    if (!Number.isNaN(min) && !Number.isNaN(max)) query.leadScore = { $gte: min, $lte: max };
  }
  applyLeadScoreStage(query, stage);
  const engagementKey = String(engagement || '').toLowerCase();
  if (engagementKey === 'high') {
    query.linkClicks = { $gt: 5 };
  } else if (engagementKey === 'medium') {
    query.linkClicks = { $gte: 1, $lte: 5 };
  } else if (engagementKey === 'low') {
    query.$and = (query.$and || []).concat([
      { $or: [{ linkClicks: { $exists: false } }, { linkClicks: 0 }] },
    ]);
  }
  const convKey = String(convStatus || '').toLowerCase();
  if (convKey === 'has_conv') {
    query.$and = (query.$and || []).concat([
      {
        $or: [
          { chatSummary: { $exists: true, $nin: [null, ''] } },
          { lastMessageContent: { $exists: true, $nin: [null, ''] } },
        ],
      },
    ]);
  } else if (convKey === 'no_conv') {
    query.$and = (query.$and || []).concat([
      {
        $and: [
          { $or: [{ chatSummary: { $exists: false } }, { chatSummary: null }, { chatSummary: '' }] },
          { $or: [{ lastMessageContent: { $exists: false } }, { lastMessageContent: null }, { lastMessageContent: '' }] },
        ],
      },
    ]);
  }
  if (lastSeen) {
    const days =
      lastSeen === '24h' ? 1 : lastSeen === '7d' ? 7 : lastSeen === '14d' ? 14 : lastSeen === '1m' ? 30 : lastSeen === '6m' ? 180 : 0;
    if (days > 0) {
      const date = new Date();
      date.setDate(date.getDate() - days);
      query.lastInteraction = { $gte: date };
    }
  }
  return query;
}

function sortStage(sortBy) {
  const key = sortBy === 'spend' ? 'ltv' : sortBy;
  if (key === 'score') return { leadScore: -1, _id: -1 };
  if (key === 'ltv') return { totalSpent: -1, _id: -1 };
  if (key === 'name') return { name: 1, _id: -1 };
  if (key === 'clicks') return { linkClicks: -1, _id: -1 };
  if (key === 'lastPurchase') return { lastPurchaseDate: -1, _id: -1 };
  if (key === 'orders') return { ordersCount: -1, _id: -1 };
  if (key === 'cartValue') return { cartValue: -1, _id: -1 };
  return { lastInteraction: -1, _id: -1 };
}

function leadsPagePipeline(query, sortBy, skip, limitNum) {
  const normalizedSort = sortBy === 'spend' ? 'ltv' : sortBy;
  if (normalizedSort === 'aov') {
    return [
      { $match: query },
      {
        $addFields: {
          __aovSort: {
            $cond: {
              if: { $gt: ['$ordersCount', 0] },
              then: { $divide: [{ $ifNull: ['$totalSpent', 0] }, '$ordersCount'] },
              else: 0,
            },
          },
        },
      },
      { $sort: { __aovSort: -1, _id: -1 } },
      { $skip: skip },
      { $limit: limitNum },
      { $project: { ...LEAD_LIST_PROJECTION, __aovSort: 0 } },
    ];
  }
  return [
    { $match: query },
    { $sort: sortStage(normalizedSort) },
    { $skip: skip },
    { $limit: limitNum },
    { $project: LEAD_LIST_PROJECTION },
  ];
}

async function enrichLeadRow(clientId, row) {
  if (!row?.phoneNumber) return normalizeLeadForDisplay(row);

  const variants = phoneVariants(row.phoneNumber);
  const [orders, conversation] = await Promise.all([
    findOrdersForLead(clientId, row.phoneNumber, { limit: 50 }),
    variants.length
      ? Conversation.findOne(
          { clientId, phone: { $in: variants } },
          { lastMessageAt: 1 }
        ).lean()
      : Promise.resolve(null),
  ]);

  let merged = row;
  if (conversation?.lastMessageAt) {
    merged = { ...row, conversationLastMessageAt: conversation.lastMessageAt };
  }

  const normalized = normalizeLeadForDisplay(merged, { orders });

  if (conversation?.lastMessageAt) {
    const convMs = new Date(conversation.lastMessageAt).getTime();
    const seenMs = normalized.displayLastSeenAt
      ? new Date(normalized.displayLastSeenAt).getTime()
      : 0;
    if (convMs > seenMs) {
      normalized.displayLastSeenAt = conversation.lastMessageAt;
      normalized.lastMessageAt = conversation.lastMessageAt;
    }
  }

  return normalized;
}

/**
 * Single round-trip: filtered page + total + workspace summary counts.
 */
async function fetchLeadsAnalyticsBundle(clientId, opts = {}) {
  const {
    search = '',
    tag,
    segmentScore,
    lastSeen,
    sortBy,
    page = 1,
    limit = 20,
    importBatchId = null,
    optStatus,
    hasPhone,
    source,
    stage,
    engagement,
    convStatus,
    periodDays: periodDaysInput,
  } = opts;

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = Math.min(parseInt(limit, 10) || 20, 500);
  const skip = (pageNum - 1) * limitNum;
  const query = buildLeadsListQuery(clientId, {
    search,
    tag,
    segmentScore,
    lastSeen,
    importBatchId,
    optStatus,
    hasPhone,
    source,
    stage,
    engagement,
    convStatus,
  });

  const periodDays = Math.min(Math.max(parseInt(periodDaysInput, 10) || 0, 0), 90);
  const periodSince =
    periodDays > 0 ? new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000) : null;

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const activeTodayCond = { $gte: ['$lastInboundAt', dayStart] };
  const activeInPeriodCond = periodSince
    ? {
        $or: [
          { $gte: ['$lastInboundAt', periodSince] },
          { $gte: ['$lastSeen', periodSince] },
        ],
      }
    : activeTodayCond;
  const convInPeriodCond = periodSince
    ? {
        $and: [
          {
            $or: [
              { $and: [{ $ne: ['$chatSummary', null] }, { $ne: ['$chatSummary', ''] }] },
              { $and: [{ $ne: ['$lastMessageContent', null] }, { $ne: ['$lastMessageContent', ''] }] },
            ],
          },
          { $gte: ['$lastSeen', periodSince] },
        ],
      }
    : {
        $or: [
          { $and: [{ $ne: ['$chatSummary', null] }, { $ne: ['$chatSummary', ''] }] },
          { $and: [{ $ne: ['$lastMessageContent', null] }, { $ne: ['$lastMessageContent', ''] }] },
        ],
      };
  const hotInPeriodCond = periodSince
    ? { $and: [{ $gt: ['$linkClicks', 5] }, { $gte: ['$lastSeen', periodSince] }] }
    : { $gt: ['$linkClicks', 5] };

  const [facetOut] = await AdLead.aggregate([
    {
      $facet: {
        page: [
          ...leadsPagePipeline(query, sortBy, skip, limitNum),
        ],
        pageTotal: [{ $match: query }, { $count: 'n' }],
        summary: [
          { $match: { clientId } },
          {
            $group: {
              _id: null,
              activeToday: {
                $sum: {
                  $cond: [activeTodayCond, 1, 0],
                },
              },
              activeInPeriod: {
                $sum: {
                  $cond: [activeInPeriodCond, 1, 0],
                },
              },
              withConversation: {
                $sum: {
                  $cond: [convInPeriodCond, 1, 0],
                },
              },
              highEngagement: {
                $sum: { $cond: [hotInPeriodCond, 1, 0] },
              },
            },
          },
        ],
      },
    },
  ]).allowDiskUse(true);

  const rawPage = facetOut?.page || [];
  const leads = await Promise.all(rawPage.map((row) => enrichLeadRow(clientId, row)));
  const total = facetOut?.pageTotal?.[0]?.n ?? 0;
  const summaryRow = facetOut?.summary?.[0] || {};
  const totalPages = Math.max(1, Math.ceil(total / limitNum));

  return {
    leads,
    currentPage: pageNum,
    totalPages,
    totalLeads: total,
    summary: {
      activeToday: summaryRow.activeToday || 0,
      activeInPeriod: summaryRow.activeInPeriod || summaryRow.activeToday || 0,
      withConversation: summaryRow.withConversation || 0,
      highEngagement: summaryRow.highEngagement || 0,
    },
    pagination: { page: pageNum, limit: limitNum, total, totalPages },
  };
}

module.exports = {
  buildLeadsListQuery,
  fetchLeadsAnalyticsBundle,
};
