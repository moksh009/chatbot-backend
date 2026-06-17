'use strict';

const FollowUpSequence = require('../../models/FollowUpSequence');
const AdLead = require('../../models/AdLead');
const log = require('../core/logger')('CancelSequencesOnReply');

function phoneVariants(phone) {
  const raw = String(phone || '').replace(/\D/g, '');
  if (!raw) return [];
  const set = new Set([raw, `+${raw}`]);
  if (raw.length === 10) set.add(`91${raw}`);
  if (raw.startsWith('91') && raw.length > 10) set.add(raw.slice(2));
  return [...set];
}

/**
 * Cancel active marketing sequences when the customer replies (cancelOnReply !== false).
 */
async function cancelSequencesOnInboundReply({ clientId, phone, reason = 'customer_replied' }) {
  if (!clientId || !phone) return 0;

  const variants = phoneVariants(phone);
  if (!variants.length) return 0;

  const lead = await AdLead.findOne({
    clientId,
    phoneNumber: { $in: variants },
  })
    .select('_id')
    .lean();

  const or = [{ phone: { $in: variants } }];
  if (lead?._id) or.push({ leadId: lead._id });

  const active = await FollowUpSequence.find({
    clientId,
    status: 'active',
    cancelOnReply: { $ne: false },
    $or: or,
  })
    .select('_id leadId')
    .lean();

  if (!active.length) return 0;

  const ids = active.map((s) => s._id);
  await FollowUpSequence.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        status: 'cancelled',
        cancelledReason: reason,
        cancelledAt: new Date(),
        'steps.$[pending].status': 'cancelled',
        'steps.$[pending].errorLog': `cancelled:${reason}`,
      },
    },
    { arrayFilters: [{ 'pending.status': { $in: ['pending', 'queued', 'retrying'] } }] }
  );

  const leadIds = [...new Set(active.map((s) => String(s.leadId)).filter(Boolean))];
  for (const leadId of leadIds) {
    const count = await FollowUpSequence.countDocuments({
      clientId,
      leadId,
      status: 'active',
    });
    await AdLead.findByIdAndUpdate(leadId, {
      $set: { 'metaData.hasActiveSequence': count > 0 },
    }).catch(() => {});
  }

  log.info('cancelled sequences on inbound reply', {
    clientId,
    count: ids.length,
    reason,
  });

  return ids.length;
}

module.exports = { cancelSequencesOnInboundReply };
