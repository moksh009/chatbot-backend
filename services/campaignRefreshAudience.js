'use strict';

const { resolveSegmentAudienceRows } = require('./segmentAudienceEvaluation');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Segment = require('../models/Segment');
const { launchCampaignDispatch } = require('./campaignLaunchService');

/**
 * Manually refresh live-audience for one campaign (dashboard "Refresh now").
 */
async function refreshCampaignAudience(campaignId, clientId) {
  const campaign = await Campaign.findOne({ _id: campaignId, clientId });
  if (!campaign) return { ok: false, status: 404, message: 'Campaign not found' };
  if (campaign.audienceMode !== 'live') {
    return { ok: false, status: 400, message: 'Campaign is not in live audience mode' };
  }
  if (!campaign.audienceRefreshable) {
    return { ok: false, status: 400, message: 'Live audience refresh is stopped for this campaign' };
  }
  if (!['SENDING', 'PAUSED'].includes(campaign.status)) {
    return { ok: false, status: 400, message: 'Campaign must be sending or paused to refresh audience' };
  }

  const maxH = (campaign.audienceRefreshHoursMax || 24) * 3600 * 1000;
  if (campaign.createdAt && Date.now() - new Date(campaign.createdAt).getTime() > maxH) {
    campaign.audienceRefreshable = false;
    await campaign.save();
    return { ok: false, status: 400, message: 'Live refresh window has ended (max hours elapsed)' };
  }

  if (!campaign.segmentId) {
    return { ok: false, status: 400, message: 'Campaign has no segment for live refresh' };
  }

  const segment = await Segment.findOne({ _id: campaign.segmentId, clientId: campaign.clientId });
  if (!segment) return { ok: false, status: 404, message: 'Segment not found' };

  const audienceRows = await resolveSegmentAudienceRows(campaign.clientId, segment);
  const existing = await CampaignMessage.find({ campaignId: campaign._id }).select('phone').lean();
  const have = new Set(existing.map((e) => e.phone));
  const newcomers = audienceRows
    .filter((l) => (l.phone || l.phoneNumber) && !have.has(l.phone || l.phoneNumber))
    .map((l) => ({ phone: l.phone || l.phoneNumber, name: l.name, _id: l._id }));

  let inserted = 0;
  if (newcomers.length) {
    const r = await launchCampaignDispatch(campaign, newcomers);
    inserted = r.inserted || 0;
  }

  campaign.lastAudienceRefreshAt = new Date();
  await campaign.save();

  return {
    ok: true,
    added: inserted,
    lastAudienceRefreshAt: campaign.lastAudienceRefreshAt,
    audienceRefreshable: campaign.audienceRefreshable,
  };
}

module.exports = { refreshCampaignAudience };
