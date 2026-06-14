'use strict';

const AdLead = require('../../models/AdLead');
const CartRecoveryAttempt = require('../../models/CartRecoveryAttempt');
const { countRecoveredCartLeads } = require('./recoveredCartMetrics');

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 1000) / 10;
}

/**
 * Recovery funnel for commerce health dashboard (Phase 7).
 */
async function buildRecoveryFunnelMetrics(clientId, from, to) {
  const range = { $gte: from, $lte: to };
  const abandonedFilter = {
    clientId,
    cartStatus: { $in: ['abandoned', 'recovered', 'purchased'] },
    $or: [{ cartAbandonedAt: range }, { contactCapturedAt: range }],
  };

  const [
    contactLeadPhones,
    promotedAbandoned,
    step1Sent,
    step2Sent,
    step3Sent,
    recovered,
    recoveredViaWa,
    attemptRecovered,
  ] = await Promise.all([
    AdLead.find({ clientId, contactCapturedAt: range })
      .select('phoneNumber')
      .lean(),
    AdLead.countDocuments(abandonedFilter),
    AdLead.countDocuments({ ...abandonedFilter, recoveryStep: { $gte: 1 } }),
    AdLead.countDocuments({ ...abandonedFilter, recoveryStep: { $gte: 2 } }),
    AdLead.countDocuments({ ...abandonedFilter, recoveryStep: { $gte: 3 } }),
    countRecoveredCartLeads(clientId, from, to),
    AdLead.countDocuments({
      clientId,
      recoveredViaWhatsApp: true,
      $or: [
        { cartStatus: { $in: ['recovered', 'purchased'] } },
        { isOrderPlaced: true },
      ],
      $and: [
        {
          $or: [
            { recoveredAt: range },
            { abandonedCartRecoveredAt: range },
            { lastPurchaseDate: range },
          ],
        },
      ],
    }),
    CartRecoveryAttempt.countDocuments({
      clientId,
      status: 'recovered',
      recoveredAt: range,
    }),
  ]);

  const messagesSent = await CartRecoveryAttempt.aggregate([
    {
      $match: {
        clientId,
        createdAt: range,
        'whatsappTemplatesSent.0': { $exists: true },
      },
    },
    { $project: { sent: { $size: { $ifNull: ['$whatsappTemplatesSent', []] } } } },
    { $group: { _id: null, total: { $sum: '$sent' } } },
  ]);
  const contactsCaptured = new Set(
    (contactLeadPhones || [])
      .map((l) => String(l.phoneNumber || '').replace(/\D/g, '').slice(-10))
      .filter((p) => p.length >= 10)
  ).size;
  const waMessagesSent = messagesSent[0]?.total || 0;

  const base = promotedAbandoned || contactsCaptured || 1;

  return {
    range: { from, to },
    funnel: {
      contactsCaptured,
      promotedAbandoned,
      step1Sent,
      step2Sent,
      step3Sent,
      recovered,
      recoveredViaWhatsApp: recoveredViaWa,
      attemptAttributed: attemptRecovered,
      waMessagesSent,
    },
    rates: {
      promoteRate: pct(promotedAbandoned, contactsCaptured),
      step1Rate: pct(step1Sent, base),
      step2Rate: pct(step2Sent, step1Sent || base),
      step3Rate: pct(step3Sent, step2Sent || base),
      recoveryRate: pct(recovered, step1Sent || base),
      whatsappRecoveryRate: pct(recoveredViaWa, step1Sent || base),
    },
  };
}

module.exports = { buildRecoveryFunnelMetrics, pct };
