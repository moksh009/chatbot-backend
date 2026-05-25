const os = require('os');
const { Worker } = require('bullmq');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const { tickRateLimitRestore } = require('../utils/messaging/channelRateLimits');
const { flushCampaignProgress, readCampaignProgress } = require('../utils/messaging/dispatch/campaignProgress');
const { launchCampaignDispatch } = require('../services/campaignLaunchService');
const { getConnection } = require('../utils/messaging/queues/queueConnection');
const log = require('../utils/core/logger')('DispatchMaintenance');

const ORPHAN_MS = 5 * 60 * 1000;

async function reapOrphanCampaignMessages() {
  const cutoff = new Date(Date.now() - ORPHAN_MS);
  const res = await CampaignMessage.updateMany(
    { status: 'processing', lockedAt: { $lt: cutoff } },
    {
      $set: { status: 'queued', lockedBy: null, lockedAt: null },
      $inc: { attempts: 0 },
    }
  );
  return res.modifiedCount || 0;
}

async function reapOrphanSequenceSteps() {
  const cutoff = new Date(Date.now() - ORPHAN_MS);
  const active = await FollowUpSequence.find({
    status: 'active',
    'steps.status': 'processing',
    'steps.lockedAt': { $lt: cutoff },
  }).select('_id steps');

  let n = 0;
  for (const seq of active) {
    seq.steps.forEach((s, idx) => {
      if (s.status === 'processing' && s.lockedAt && s.lockedAt < cutoff) {
        s.status = 'queued';
        s.lockedBy = null;
        s.lockedAt = null;
        n += 1;
      }
    });
    await seq.save();
  }
  return n;
}

async function flushAllCampaignProgress() {
  const sending = await Campaign.find({ status: 'SENDING' }).select('_id clientId recipientCount').lean();
  for (const c of sending) {
    await flushCampaignProgress(c._id, c.clientId, { totalHint: c.recipientCount });
    const counts = await readCampaignProgress(c._id);
    await Campaign.updateOne(
      { _id: c._id },
      {
        $set: {
          'stats.queued': counts.queued || 0,
          'stats.processing': counts.processing || 0,
          'stats.sent': counts.sent || 0,
          'stats.failed': counts.failed || 0,
          'stats.cancelled': counts.cancelled || 0,
          'stats.lastProgressAt': new Date(),
        },
      }
    );
  }
}

async function refreshLiveAudiences() {
  const now = Date.now();
  const campaigns = await Campaign.find({
    audienceMode: 'live',
    audienceRefreshable: true,
    status: 'SENDING',
  });

  let added = 0;
  for (const campaign of campaigns) {
    const maxH = (campaign.audienceRefreshHoursMax || 24) * 3600 * 1000;
    if (campaign.createdAt && now - new Date(campaign.createdAt).getTime() > maxH) {
      campaign.audienceRefreshable = false;
      await campaign.save();
      continue;
    }
    if (!campaign.segmentId) continue;
    const Segment = require('../models/Segment');
    const segment = await Segment.findById(campaign.segmentId);
    if (!segment) continue;

    const leads = await AdLead.find({ ...segment.query, clientId: campaign.clientId }).lean();
    const existing = await CampaignMessage.find({ campaignId: campaign._id }).select('phone').lean();
    const have = new Set(existing.map((e) => e.phone));
    const newcomers = leads
      .filter((l) => l.phoneNumber && !have.has(l.phoneNumber))
      .map((l) => ({ phone: l.phoneNumber, name: l.name, _id: l._id }));
    if (!newcomers.length) continue;
    const r = await launchCampaignDispatch(campaign, newcomers);
    added += r.inserted || 0;
    campaign.lastAudienceRefreshAt = new Date();
    await campaign.save();
  }
  return added;
}

async function probeConnectionTokens() {
  const Client = require('../models/Client');
  const { probeClientChannels } = require('../utils/security/connectionTokenProbe');
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const clients = await Client.find({
    $or: [{ lastActiveAt: { $gte: weekAgo } }, { updatedAt: { $gte: weekAgo } }],
  })
    .select('clientId whatsappToken shopifyAccessToken shopDomain razorpayKeyId razorpaySecret')
    .limit(50)
    .lean();
  let n = 0;
  for (const c of clients) {
    await probeClientChannels(c);
    n += 1;
  }
  return n;
}

async function runMaintenanceTick() {
  const orphans = (await reapOrphanCampaignMessages()) + (await reapOrphanSequenceSteps());
  const rate = await tickRateLimitRestore();
  await flushAllCampaignProgress();
  const live = await refreshLiveAudiences();
  const probed = await probeConnectionTokens().catch(() => 0);
  if (orphans || rate.restored || live || probed) {
    log.info(`Maintenance: orphans=${orphans} rateRestored=${rate.restored} liveAdded=${live} probed=${probed}`);
  }
}

function startDispatchMaintenanceWorker() {
  const connection = getConnection();
  if (!connection) return null;
  const worker = new Worker(
    'dispatch-maintenance',
    async () => runMaintenanceTick(),
    { connection, concurrency: 1 }
  );
  log.info('Dispatch maintenance worker started');
  return worker;
}

module.exports = { startDispatchMaintenanceWorker, runMaintenanceTick };
