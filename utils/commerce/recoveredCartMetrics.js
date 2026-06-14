'use strict';

const AdLead = require('../../models/AdLead');

/**
 * Canonical filter: lead recovered from abandon (WhatsApp or organic purchase).
 */
function recoveredCartLeadMatch(clientId, extra = {}) {
  return {
    clientId,
    ...extra,
    $or: [
      { cartStatus: { $in: ['recovered', 'purchased'] } },
      { isOrderPlaced: true },
    ],
  };
}

function recoveredInRangeClause(from, to) {
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return {
    $or: [
      { recoveredAt: range },
      { abandonedCartRecoveredAt: range },
      { lastPurchaseDate: range },
    ],
  };
}

/**
 * Count + revenue from AdLead documents (includes organic `purchased` status).
 */
async function getRecoveredCartLeadTotals(clientId, from, to) {
  const match = recoveredCartLeadMatch(clientId);
  const rangeClause = recoveredInRangeClause(from, to);
  if (rangeClause) match.$and = [rangeClause];

  const [agg] = await AdLead.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        revenue: {
          $sum: {
            $ifNull: ['$lifetimeValue', { $ifNull: ['$cartValue', 0] }],
          },
        },
        waCount: { $sum: { $cond: [{ $eq: ['$recoveredViaWhatsApp', true] }, 1, 0] } },
        organicCount: { $sum: { $cond: [{ $ne: ['$recoveredViaWhatsApp', true] }, 1, 0] } },
        waRevenue: {
          $sum: {
            $cond: [
              { $eq: ['$recoveredViaWhatsApp', true] },
              { $ifNull: ['$lifetimeValue', { $ifNull: ['$cartValue', 0] }] },
              0,
            ],
          },
        },
        organicRevenue: {
          $sum: {
            $cond: [
              { $ne: ['$recoveredViaWhatsApp', true] },
              { $ifNull: ['$lifetimeValue', { $ifNull: ['$cartValue', 0] }] },
              0,
            ],
          },
        },
      },
    },
  ]);

  return {
    recoveredCarts: agg?.count || 0,
    revenueRecovered: Math.round(agg?.revenue || 0),
    recoveredFromWhatsapp: agg?.waCount || 0,
    revenueRecoveredFromWhatsapp: Math.round(agg?.waRevenue || 0),
    organicRecovered: agg?.organicCount || 0,
    organicRevenue: Math.round(agg?.organicRevenue || 0),
  };
}

async function countRecoveredCartLeads(clientId, from, to) {
  const totals = await getRecoveredCartLeadTotals(clientId, from, to);
  return totals.recoveredCarts;
}

module.exports = {
  recoveredCartLeadMatch,
  recoveredInRangeClause,
  getRecoveredCartLeadTotals,
  countRecoveredCartLeads,
};
