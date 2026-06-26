const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const AdLead = require('../models/AdLead');
const { bulkEnqueueCampaignJobs } = require('../utils/messaging/queues/campaignDispatchQueue');
const { predictOptimalHour } = require('./predictive/heuristic');
const { assignAbVariant, incrCampaignProgress } = require('../utils/messaging/dispatch/campaignProgress');
const { normalizeEmail, normalizePhoneDigits } = require('../utils/commerce/marketingConsent');
const { sanitizePhoneForStorage } = require('../utils/core/phoneE164Policy');
const log = require('../utils/core/logger')('CampaignLaunch');

function buildVariants(campaign) {
  if (!campaign.isAbTest || !campaign.abVariants?.length) return null;
  const holdbackPercent = Number(campaign.abTestConfig?.holdbackPercent ?? 20);
  return {
    holdbackPercent,
    variants: campaign.abVariants.map((v, i) => ({
      id: v.label || v.id || String(i),
      label: v.label,
      templateName: v.templateName,
      weight: v.weight || 50,
    })),
  };
}

/**
 * Bulk insert CampaignMessage rows and enqueue dispatch jobs (Module 4).
 */
function nextOptimalSendAt(hour, from = new Date()) {
  const d = new Date(from);
  d.setHours(hour, 0, 0, 0);
  if (d <= from) d.setDate(d.getDate() + 1);
  return d;
}

async function launchCampaignDispatch(campaign, audienceRows = []) {
  if (!campaign || !audienceRows.length) return { inserted: 0, enqueued: 0 };

  const perContact =
    campaign.scheduleStrategy === 'per_contact_optimal' || campaign.isPredictiveSend === true;
  const leadIds = audienceRows.filter((r) => r._id).map((r) => String(r._id));
  const leadsById = perContact && leadIds.length
    ? Object.fromEntries(
        (
          await AdLead.find({ _id: { $in: leadIds }, clientId: campaign.clientId })
            .select('_id optimalSendHour engagementHours')
            .lean()
        ).map((l) => [String(l._id), l])
      )
    : {};

  const ab = buildVariants(campaign);
  const isEmail = String(campaign.channel || 'whatsapp').toLowerCase() === 'email';
  const docs = [];
  const jobDelays = [];
  const now = Date.now();
  for (const row of audienceRows) {
    let phone;
    let email;
    if (isEmail) {
      email = normalizeEmail(row.email);
      if (!email) continue;
      phone = `email:${email}`;
    } else {
      phone = sanitizePhoneForStorage(row.phone || row.phoneNumber) || normalizePhoneDigits(row.phone || row.phoneNumber);
      if (!phone) continue;
    }
    const leadKey = row._id ? String(row._id) : phone;
    let variantId = null;
    let abVariantLabel = null;
    let status = 'queued';

    if (ab) {
      const pick = assignAbVariant({
        campaignId: String(campaign._id),
        leadKey,
        variants: ab.variants,
        holdbackPercent: ab.holdbackPercent,
      });
      if (pick.holdback) {
        status = 'queued';
        abVariantLabel = 'holdout';
      } else {
        variantId = pick.variantId;
        abVariantLabel = pick.variantId;
      }
    }

    let scheduledSendAt = null;
    if (perContact) {
      const lead = row._id ? leadsById[String(row._id)] : null;
      const hour = predictOptimalHour(lead || {}, 11);
      scheduledSendAt = nextOptimalSendAt(hour);
    }

    docs.push({
      campaignId: campaign._id,
      clientId: campaign.clientId,
      phone,
      status,
      attempts: 0,
      variantId,
      abVariantLabel,
      scheduledSendAt,
      metadata: { name: row.name, leadId: row._id, email: email || row.email || null },
    });
    jobDelays.push(scheduledSendAt ? Math.max(0, scheduledSendAt.getTime() - now) : 0);
  }

  const inserted = await CampaignMessage.insertMany(docs, { ordered: false });
  campaign.status = 'SENDING';
  campaign.recipientCount = inserted.length;
  campaign.queuedCount = inserted.length;
  if (campaign.audienceMode === 'live') campaign.audienceRefreshable = true;
  await campaign.save();

  const jobs = inserted.map((cm, i) => ({
    campaignMessageId: String(cm._id),
    campaignId: String(campaign._id),
    clientId: campaign.clientId,
    channel: campaign.channel || 'whatsapp',
    delayMs: jobDelays[i] || 0,
  }));

  const enqueued = await bulkEnqueueCampaignJobs(jobs);
  await incrCampaignProgress(campaign._id, 'queued', inserted.length);

  const io = global.io;
  if (io) {
    io.to(`client_${campaign.clientId}`).emit('campaign:started', {
      campaignId: campaign._id,
      total: inserted.length,
      at: new Date().toISOString(),
    });
  }

  log.info(`Launched campaign ${campaign._id}: messages=${inserted.length} jobs=${enqueued}`);
  return { inserted: inserted.length, enqueued };
}

async function reenqueueQueuedMessages(campaignId) {
  const rows = await CampaignMessage.find({
    campaignId,
    status: { $in: ['queued', 'retrying'] },
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }],
  }).select('_id clientId campaignId').lean();

  const campaign = await Campaign.findById(campaignId).select('channel').lean();
  const ch = campaign?.channel || 'whatsapp';
  const jobs = rows.map((r) => ({
    campaignMessageId: String(r._id),
    campaignId: String(r.campaignId),
    clientId: r.clientId,
    channel: ch,
  }));
  return bulkEnqueueCampaignJobs(jobs);
}

module.exports = { launchCampaignDispatch, reenqueueQueuedMessages, assignAbVariant };
