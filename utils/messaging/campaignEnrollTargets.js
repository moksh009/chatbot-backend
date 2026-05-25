const CampaignMessage = require('../../models/CampaignMessage');
const Message = require('../../models/Message');

/**
 * Resolve enrollment targets from CampaignMessage ground truth (Phase 2 B3).
 */
async function resolveCampaignEnrollTargets({ clientId, campaignId, condition }) {
  const baseFilter = { clientId, campaignId };

  if (condition === 'all_delivered') {
    const rows = await CampaignMessage.find({ ...baseFilter, status: 'delivered' })
      .select('phone deliveredAt')
      .lean();
    return rows.map((r) => ({ phone: r.phone, deliveredAt: r.deliveredAt }));
  }

  if (condition === 'no_read') {
    const rows = await CampaignMessage.find({ ...baseFilter, status: 'delivered' })
      .select('phone deliveredAt')
      .lean();
    return rows;
  }

  if (condition === 'no_reply') {
    const delivered = await CampaignMessage.find({ ...baseFilter, status: 'delivered' })
      .select('phone deliveredAt')
      .lean();

    const out = [];
    for (const row of delivered) {
      const since = row.deliveredAt || new Date(0);
      const replied = await Message.exists({
        clientId,
        phone: row.phone,
        direction: 'incoming',
        timestamp: { $gte: since },
      });
      if (!replied) out.push({ phone: row.phone, deliveredAt: row.deliveredAt });
    }
    return out;
  }

  if (condition === 'no_click') {
    const read = await CampaignMessage.find({
      ...baseFilter,
      status: { $in: ['read', 'replied'] },
    })
      .select('phone deliveredAt readAt')
      .lean();
    return read;
  }

  return [];
}

module.exports = { resolveCampaignEnrollTargets };
