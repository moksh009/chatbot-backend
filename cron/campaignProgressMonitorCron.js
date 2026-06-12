const cron = require('node-cron');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Client = require('../models/Client');
const log = require('../utils/core/logger')('CampaignProgressMonitor');
const { launchCampaignDispatch } = require('../services/campaignLaunchService');
const { bulkEnqueueCampaignJobs } = require('../utils/messaging/queues/campaignDispatchQueue');
const { resolveImportBatchObjectId } = require('../utils/core/importBatchResolver');
const {
  audienceOptQueryForCampaign,
} = require('../utils/commerce/marketingConsent');

const STALE_TIMEOUT_HOURS = 2;

async function resolveHotLeadsAudience(campaign) {
  const AdLead = require('../models/AdLead');
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
    .lean();
  return leads.map((l) => ({
    phone: l.phoneNumber,
    email: l.email || '',
    name: l.name || 'Customer',
    _id: l._id,
  }));
}

async function resolveAudience(campaign) {
  let phones = campaign.audience || [];
  if (phones.length) return phones;
  if (campaign.isSmartSend) {
    return resolveHotLeadsAudience(campaign);
  }
  if (campaign.segmentId) {
    const Segment = require('../models/Segment');
    const AdLead = require('../models/AdLead');
    const segment = await Segment.findById(campaign.segmentId);
    if (segment) {
      const optQ = audienceOptQueryForCampaign(campaign);
      const leads = await AdLead.find({ ...segment.query, clientId: campaign.clientId, ...optQ })
        .lean();
      phones = leads.map((l) => ({
        phone: l.phoneNumber,
        email: l.email,
        name: l.name || 'Customer',
        _id: l._id,
      }));
    }
  } else if (campaign.importBatchId) {
    const AdLead = require('../models/AdLead');
    const resolvedBatchId = await resolveImportBatchObjectId(campaign.importBatchId, campaign.clientId);
    if (resolvedBatchId) {
      const optQ = audienceOptQueryForCampaign(campaign);
      const leads = await AdLead.find({
        importBatchId: resolvedBatchId,
        clientId: campaign.clientId,
        ...optQ,
      }).lean();
      phones = leads.map((l) => ({
        phone: l.phoneNumber,
        email: l.email,
        name: l.name || 'Customer',
        _id: l._id,
      }));
    }
  }
  return phones;
}

async function markCompletedIfDone(campaign) {
  const pending = await CampaignMessage.countDocuments({
    campaignId: campaign._id,
    status: { $in: ['queued', 'processing', 'retrying'] },
  });
  if (pending > 0) return false;
  const failed = await CampaignMessage.countDocuments({ campaignId: campaign._id, status: 'failed' });
  const total = await CampaignMessage.countDocuments({ campaignId: campaign._id });
  campaign.status = failed === total && total > 0 ? 'FAILED' : 'COMPLETED';
  await campaign.save();
  const io = global.io;
  if (io) {
    io.to(`client_${campaign.clientId}`).emit('campaign:completed', {
      campaignId: campaign._id,
      failed,
      total,
    });
  }
  return true;
}

async function enqueueMissingJobsForSending(campaign) {
  const queued = await CampaignMessage.find({
    campaignId: campaign._id,
    status: { $in: ['queued', 'retrying'] },
  })
    .select('_id clientId campaignId')
    .lean();
  if (!queued.length) return 0;
  const jobs = queued.map((r) => ({
    campaignMessageId: String(r._id),
    campaignId: String(r.campaignId),
    clientId: r.clientId,
    channel: campaign.channel || 'whatsapp',
  }));
  return bulkEnqueueCampaignJobs(jobs);
}

async function runCampaignProgressMonitorTick() {
  try {
    const cronQuery = { bypassClientScope: true };
    const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_HOURS * 60 * 60 * 1000);
    const stale = await Campaign.find({ status: 'SENDING', updatedAt: { $lte: staleThreshold } }).setOptions(cronQuery);
    for (const c of stale) {
      const pending = await CampaignMessage.countDocuments({
        campaignId: c._id,
        status: { $in: ['queued', 'processing', 'retrying'] },
      });
      if (pending === 0) await markCompletedIfDone(c);
      else {
        c.status = 'FAILED';
        c.autoPaused = true;
        c.autoPausedReason = `Timed out after ${STALE_TIMEOUT_HOURS}h in SENDING`;
        await c.save();
      }
    }

    const now = new Date();
    const toLaunch = await Campaign.find({
      isAbTest: false,
      $or: [
        { status: 'QUEUED', $or: [{ scheduledAt: { $lte: now } }, { scheduledAt: null }] },
        { status: 'SCHEDULED', scheduledAt: { $lte: now } },
      ],
    }).setOptions(cronQuery);

    for (const campaign of toLaunch) {
      const phones = await resolveAudience(campaign);
      if (!phones.length) {
        campaign.status = 'COMPLETED';
        await campaign.save();
        continue;
      }
      await launchCampaignDispatch(campaign, phones);
    }

    const sending = await Campaign.find({ status: 'SENDING' }).setOptions(cronQuery);
    for (const campaign of sending) {
      await enqueueMissingJobsForSending(campaign);
      await markCompletedIfDone(campaign);
    }
  } catch (err) {
    log.error(`Progress monitor error: ${err.message}`);
  }
}

const scheduleCampaignProgressMonitor = () => {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  cron.schedule('*/2 * * * *', runCampaignProgressMonitorTick);
};

scheduleCampaignProgressMonitor.runTick = runCampaignProgressMonitorTick;
module.exports = scheduleCampaignProgressMonitor;
