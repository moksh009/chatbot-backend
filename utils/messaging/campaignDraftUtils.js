'use strict';

const CAMPAIGN_DRAFT_STATUSES = new Set(['DRAFT', 'PAUSED', 'SCHEDULED']);

const CAMPAIGN_PATCH_FIELDS = [
  'name',
  'channel',
  'templateName',
  'emailSubject',
  'emailHtml',
  'variableMapping',
  'customTextValues',
  'templateComponents',
  'languageCode',
  'audienceMode',
  'scheduleStrategy',
  'campaignType',
  'templateCategory',
  'scheduledAt',
];

function resetCampaignSendStats() {
  return {
    status: 'DRAFT',
    scheduledAt: undefined,
    winnerVariant: undefined,
    autoPaused: false,
    autoPausedReason: '',
    marketingOptInExcludedCount: 0,
    recipientCount: 0,
    sentCount: 0,
    deliveredCount: 0,
    readCount: 0,
    repliedCount: 0,
    failedCount: 0,
    processingCount: 0,
    queuedCount: 0,
    websiteClicks: 0,
    buttonClicks: 0,
    revenueAttributed: 0,
    attributedOrders: 0,
    stats: {
      queued: 0,
      processing: 0,
      sent: 0,
      delivered: 0,
      failed: 0,
      cancelled: 0,
      lastProgressAt: null,
    },
    lastAudienceRefreshAt: null,
  };
}

function cloneCampaignDocument(source, { name } = {}) {
  const raw = source?.toObject ? source.toObject() : { ...source };
  delete raw._id;
  delete raw.__v;
  delete raw.createdAt;
  return {
    ...raw,
    ...resetCampaignSendStats(),
    name: name || `${source.name || 'Campaign'} (copy)`,
  };
}

function applyCampaignPatch(campaign, body = {}) {
  for (const key of CAMPAIGN_PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (key === 'channel') {
      const ch = String(body.channel || '').toLowerCase();
      campaign.channel = ch === 'email' ? 'email' : 'whatsapp';
      continue;
    }
    if (key === 'scheduledAt') {
      const raw = body.scheduledAt;
      campaign.scheduledAt = raw ? new Date(raw) : null;
      if (campaign.scheduledAt && !Number.isNaN(campaign.scheduledAt.getTime())) {
        campaign.status = 'SCHEDULED';
      } else if (campaign.status === 'SCHEDULED') {
        campaign.status = 'DRAFT';
        campaign.scheduledAt = null;
      }
      continue;
    }
    campaign[key] = body[key];
  }
}

module.exports = {
  CAMPAIGN_DRAFT_STATUSES,
  CAMPAIGN_PATCH_FIELDS,
  resetCampaignSendStats,
  cloneCampaignDocument,
  applyCampaignPatch,
};
