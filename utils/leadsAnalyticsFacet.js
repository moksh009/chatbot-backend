'use strict';

const AdLead = require('../models/AdLead');

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
  inboundMessageCount: 1,
};

function buildLeadsListQuery(clientId, { search, tag, segmentScore, lastSeen }) {
  const query = { clientId };
  if (search) {
    const searchRegex = new RegExp(search, 'i');
    query.$or = [{ name: searchRegex }, { phoneNumber: searchRegex }];
  }
  if (tag) query.tags = tag;
  if (segmentScore) {
    const [min, max] = segmentScore.split('-').map(Number);
    if (!Number.isNaN(min) && !Number.isNaN(max)) query.leadScore = { $gte: min, $lte: max };
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
  if (sortBy === 'score') return { leadScore: -1, _id: -1 };
  if (sortBy === 'ltv') return { totalSpent: -1, _id: -1 };
  if (sortBy === 'name') return { name: 1, _id: -1 };
  if (sortBy === 'clicks') return { linkClicks: -1, _id: -1 };
  if (sortBy === 'lastPurchase') return { lastPurchaseDate: -1, _id: -1 };
  if (sortBy === 'orders') return { ordersCount: -1, _id: -1 };
  if (sortBy === 'cartValue') return { cartValue: -1, _id: -1 };
  return { lastInteraction: -1, _id: -1 };
}

function leadsPagePipeline(query, sortBy, skip, limitNum) {
  if (sortBy === 'aov') {
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
    { $sort: sortStage(sortBy) },
    { $skip: skip },
    { $limit: limitNum },
    { $project: LEAD_LIST_PROJECTION },
  ];
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
  } = opts;

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = Math.min(parseInt(limit, 10) || 20, 500);
  const skip = (pageNum - 1) * limitNum;
  const query = buildLeadsListQuery(clientId, { search, tag, segmentScore, lastSeen });

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

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
                  $cond: [{ $gte: ['$lastInboundAt', dayStart] }, 1, 0],
                },
              },
              withConversation: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        { $and: [{ $ne: ['$chatSummary', null] }, { $ne: ['$chatSummary', ''] }] },
                        { $and: [{ $ne: ['$lastMessageContent', null] }, { $ne: ['$lastMessageContent', ''] }] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              highEngagement: {
                $sum: { $cond: [{ $gt: ['$linkClicks', 5] }, 1, 0] },
              },
            },
          },
        ],
      },
    },
  ]).allowDiskUse(true);

  const leads = facetOut?.page || [];
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
