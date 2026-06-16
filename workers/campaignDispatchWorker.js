const os = require('os');
const { Worker } = require('bullmq');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Client = require('../models/Client');
const { sendEnvelope } = require('../utils/messaging/sendEnvelope');
const { intentFromTemplateCategory } = require('../utils/messaging/envelopeHelpers');
const { buildMappedBodyComponent } = require('../utils/meta/templateParams');
const { mergeEmailForLead } = require('../utils/core/emailMergeFields');
const { htmlToPlainText } = require('../utils/core/emailService');
const AdLead = require('../models/AdLead');
const { transitionCampaignMessage } = require('../utils/messaging/transitions/campaignMessageTransition');
const { acquire, release } = require('../utils/messaging/concurrency/tenantConcurrencyGate');
const { startHeartbeat, stopHeartbeat } = require('../utils/messaging/concurrency/heartbeat');
const { classifyEnvelopeOutcome } = require('../utils/messaging/dispatch/dispatchOutcomeHandler');
const { incrCampaignProgress, flushCampaignProgress } = require('../utils/messaging/dispatch/campaignProgress');
const { enqueueCampaignMessageJob } = require('../utils/messaging/queues/campaignDispatchQueue');
const { getConnection } = require('../utils/messaging/queues/queueConnection');
const { applyRateLimitThrottle } = require('../utils/messaging/channelRateLimits');
const log = require('../utils/core/logger')('CampaignDispatchWorker');
const { logDispatchEvent } = require('../utils/messaging/dispatchEventLog');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const CONCURRENCY = Number(process.env.PHASE3_CAMPAIGN_CONCURRENCY || 100);

async function buildComponents(campaign, client, cm) {
  let components = campaign.templateComponents ? JSON.parse(JSON.stringify(campaign.templateComponents)) : [];
  const row = cm.metadata || {};
  const mappedBody = buildMappedBodyComponent({
    variableMapping: campaign.variableMapping || {},
    row,
    customTextValues: campaign.customTextValues || {},
    client,
  });
  if (mappedBody) {
    const idx = components.findIndex((c) => c.type === 'body');
    if (idx !== -1) components[idx].parameters = mappedBody.parameters;
    else components.push(mappedBody);
  }
  return components;
}

async function processCampaignDispatchJob(job) {
  const { campaignMessageId, campaignId, clientId, channel = 'whatsapp' } = job.data;
  const cm = await CampaignMessage.findById(campaignMessageId);
  if (!cm) return;

  if (cm.scheduledSendAt && new Date(cm.scheduledSendAt) > new Date()) {
    const delay = new Date(cm.scheduledSendAt).getTime() - Date.now();
    await enqueueCampaignMessageJob(job.data, { delay: Math.max(1000, delay) });
    return;
  }

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) return;

  if (campaign.status === 'PAUSED') {
    await enqueueCampaignMessageJob(job.data, { delay: 5000 });
    return;
  }
  if (campaign.status !== 'SENDING') {
    if (cm.status === 'queued' || cm.status === 'retrying') {
      await transitionCampaignMessage(cm._id, cm.status, 'cancelled', {
        cancelledReason: 'campaign_not_sending',
        cancelledAt: new Date(),
      }).catch(() => {});
      await incrCampaignProgress(campaignId, 'cancelled', 1);
    }
    return;
  }

  if (cm.abVariantLabel === 'holdout') return;

  const client = await Client.findOne({ clientId }).lean();
  if (!client) return;

  const gate = await acquire({ client, clientId, channel });
  if (!gate.acquired) {
    await enqueueCampaignMessageJob(job.data, { delay: (gate.retryAfter || 2) * 1000 });
    return;
  }

  const fromStatus = cm.status;
  let hbKey;
  try {
    await transitionCampaignMessage(cm._id, fromStatus, 'processing', {
      lockedBy: WORKER_ID,
      lockedAt: new Date(),
      attempts: (cm.attempts || 0) + 1,
      lastAttemptAt: new Date(),
    });
    await incrCampaignProgress(campaignId, fromStatus, -1);
    await incrCampaignProgress(campaignId, 'processing', 1);

    hbKey = startHeartbeat({ workerId: WORKER_ID, type: 'campaign_message', recordId: cm._id });

    let templateName = campaign.templateName;
    if (cm.variantId && campaign.abVariants?.length) {
      const v = campaign.abVariants.find((x) => (x.label || x.id) === cm.variantId);
      if (v?.templateName) templateName = v.templateName;
    }

    const isEmail = String(channel || campaign.channel || '').toLowerCase() === 'email';
    const intent = isEmail ? 'marketing' : intentFromTemplateCategory(campaign.templateCategory);
    const emailAddr =
      cm.metadata?.email || String(cm.phone || '').replace(/^email:/i, '');
    let payload;
    let envelopeContext = {
      source: 'workers/campaignDispatchWorker',
      campaignId: String(campaignId),
    };

    if (isEmail) {
      let leadForMerge = {
        name: cm.metadata?.name || '',
        email: emailAddr,
        phoneNumber: String(cm.phone || '').startsWith('email:') ? '' : cm.phone,
      };
      if (cm.metadata?.leadId) {
        const leadDoc = await AdLead.findById(cm.metadata.leadId)
          .select('name email phoneNumber cartSnapshot')
          .lean();
        if (leadDoc) {
          leadForMerge = { ...leadDoc, email: emailAddr || leadDoc.email };
        }
      }
      const merged = mergeEmailForLead(
        campaign.emailSubject || 'Update from your store',
        campaign.emailHtml || '<p>Hello,</p>',
        leadForMerge,
        client
      );
      payload = {
        subject: merged.subject,
        html: merged.html,
        text: htmlToPlainText(merged.html),
      };
      envelopeContext = {
        ...envelopeContext,
        subject: merged.subject,
        recipientEmail: emailAddr,
        templateId: campaign.templateName || undefined,
        templateName: campaign.templateName || merged.subject,
      };
    } else {
      payload = {
        templateName,
        templateLanguage: campaign.languageCode || 'en',
        components: await buildComponents(campaign, client, cm),
      };
    }

    const result = await sendEnvelope({
      clientId,
      channel: isEmail ? 'email' : channel,
      intent,
      contact: isEmail ? { email: emailAddr } : { phone: cm.phone },
      contactId: cm.metadata?.leadId,
      payload,
      idempotency: { key: `campaign-msg:${campaignMessageId}` },
      context: envelopeContext,
    });

    const fresh = await CampaignMessage.findById(campaignMessageId);
    const outcome = classifyEnvelopeOutcome(result, fresh?.attempts || 1);

    if (outcome.action === 'sent') {
      await transitionCampaignMessage(campaignMessageId, 'processing', 'sent', {
        messageId: outcome.messageId || result.messageId,
        sentAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        recoveredFromDuplicate: !!outcome.recoveredFromDuplicate,
      });
      await incrCampaignProgress(campaignId, 'processing', -1);
      await incrCampaignProgress(campaignId, 'sent', 1);
      await Campaign.updateOne({ _id: campaignId }, { $inc: { sentCount: 1 } });
      logDispatchEvent('CampaignDispatch', 'campaign_message_sent', {
        clientId,
        campaignId: String(campaignId),
        campaignMessageId: String(campaignMessageId),
        channel: isEmail ? 'email' : channel,
        outcome: 'sent',
        messageId: outcome.messageId || result.messageId || null,
      });
    } else if (outcome.action === 'cancelled') {
      await transitionCampaignMessage(campaignMessageId, 'processing', 'cancelled', {
        cancelledReason: outcome.cancelledReason || outcome.reason,
        cancelledAt: new Date(),
        lockedBy: null,
        lockedAt: null,
      });
      await incrCampaignProgress(campaignId, 'processing', -1);
      await incrCampaignProgress(campaignId, 'cancelled', 1);
    } else if (outcome.action === 'retry') {
      const nextAt = new Date(Date.now() + outcome.delaySec * 1000);
      await transitionCampaignMessage(campaignMessageId, 'processing', 'retrying', {
        nextAttemptAt: nextAt,
        failureReason: outcome.reason,
        lockedBy: null,
        lockedAt: null,
      });
      await incrCampaignProgress(campaignId, 'processing', -1);
      await incrCampaignProgress(campaignId, 'retrying', 1);
      await enqueueCampaignMessageJob(job.data, { delay: outcome.delaySec * 1000 });
    } else {
      await transitionCampaignMessage(campaignMessageId, 'processing', 'failed', {
        failureReason: outcome.reason || 'failed',
        failedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
      });
      await incrCampaignProgress(campaignId, 'processing', -1);
      await incrCampaignProgress(campaignId, 'failed', 1);
      await Campaign.updateOne({ _id: campaignId }, { $inc: { failedCount: 1 } });
      logDispatchEvent('CampaignDispatch', 'campaign_message_failed', {
        clientId,
        campaignId: String(campaignId),
        campaignMessageId: String(campaignMessageId),
        channel: isEmail ? 'email' : channel,
        outcome: 'failed',
        reason: outcome.reason || 'failed',
      }, 'warn');
    }

    if (result?.blockedBy === 'rate_limit' || result?.status === 'blocked') {
      await applyRateLimitThrottle(clientId, channel, result.reason || 'meta_429').catch(() => {});
    }

    await flushCampaignProgress(campaignId, clientId, { totalHint: campaign.recipientCount });
  } catch (err) {
    log.warn(`Job ${campaignMessageId} error: ${err.message}`);
    if (err.code === 'transition_conflict') return;
    await CampaignMessage.updateOne(
      { _id: campaignMessageId, status: 'processing' },
      { $set: { status: 'failed', failureReason: err.message, failedAt: new Date() } }
    ).catch(() => {});
  } finally {
    if (hbKey) stopHeartbeat(hbKey);
    await release({ clientId, channel });
  }
}

function startCampaignDispatchWorker() {
  const connection = getConnection();
  if (!connection) {
    log.warn('Redis unavailable — campaign dispatch worker disabled');
    return null;
  }
  const worker = new Worker('campaign-dispatch', processCampaignDispatchJob, {
    connection,
    concurrency: CONCURRENCY,
  });
  worker.on('failed', (job, err) => log.warn(`Job ${job?.id} failed: ${err.message}`));
  log.info(`Campaign dispatch worker started (concurrency=${CONCURRENCY})`);
  return worker;
}

module.exports = { startCampaignDispatchWorker, processCampaignDispatchJob };
