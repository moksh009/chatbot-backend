const cron = require('node-cron');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Client = require('../models/Client');
const WhatsApp = require('../utils/whatsapp');
const log = require('../utils/logger')('CampaignCron');
const { resolveImportBatchObjectId } = require('../utils/importBatchResolver');

/** Minimum gap between WhatsApp Cloud API sends (burst-safe). */
const MIN_MESSAGE_GAP_MS = 50;
const STALE_TIMEOUT_HOURS = 2;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const scheduleCampaignCron = () => {
  // Run every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      // ─── Phase 1: Stale Campaign Recovery ───
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_HOURS * 60 * 60 * 1000);
      const staleCampaigns = await Campaign.find({
        status: 'SENDING',
        updatedAt: { $lte: staleThreshold }
      });
      for (const stale of staleCampaigns) {
        log.warn(`[CampaignCron] ⏰ Campaign ${stale.name} stuck in SENDING for >${STALE_TIMEOUT_HOURS}h. Marking FAILED.`);
        stale.status = 'FAILED';
        stale.autoPaused = true;
        stale.autoPausedReason = `Timed out after ${STALE_TIMEOUT_HOURS} hours in SENDING state`;
        await stale.save();
      }

      // ─── Phase 2: AB Test Winner Evaluation ───
      const pendingEvaluations = await Campaign.find({
        isAbTest: true,
        status: "SCHEDULED",
        "abTestConfig.holdbackProcessed": false,
        scheduledAt: { $lte: new Date() }
      });

      for (const campaign of pendingEvaluations) {
        try {
          log.info(`[CampaignCron] 🏆 Evaluating winner for Campaign: ${campaign.name}`);

          const variants = campaign.abVariants || [];
          if (variants.length < 2) {
            log.warn(`[CampaignCron] Campaign ${campaign.name} has <2 variants. Skipping AB evaluation.`);
            continue;
          }

          // Determine winner by configured metric (default: reply_rate)
          const metric = campaign.abTestConfig?.winnerMetric || 'reply_rate';
          const winner = variants.reduce((prev, current) => {
            let prevScore, currentScore;
            if (metric === 'read_rate') {
              prevScore = (prev.readCount || 0) / (prev.sentCount || 1);
              currentScore = (current.readCount || 0) / (current.sentCount || 1);
            } else {
              prevScore = (prev.repliedCount || 0) / (prev.sentCount || 1);
              currentScore = (current.repliedCount || 0) / (current.sentCount || 1);
            }
            return currentScore > prevScore ? current : prev;
          });

          log.info(`[CampaignCron] 🎉 Winner is Variant ${winner.label} (${winner.templateName})`);
          campaign.winnerVariant = winner.label;
          campaign.status = 'SENDING';
          await campaign.save();

          // ─── Dispatch to holdback group ───
          const client = await Client.findOne({ clientId: campaign.clientId });
          if (!client) {
            log.error(`[CampaignCron] Client ${campaign.clientId} not found for AB dispatch.`);
            campaign.status = 'FAILED';
            await campaign.save();
            continue;
          }

          const holdbackMessages = await CampaignMessage.find({
            campaignId: campaign._id,
            abVariantLabel: 'holdout',
            status: 'queued'
          });

          log.info(`[CampaignCron] Dispatching winner template to ${holdbackMessages.length} holdback recipients.`);

          let holdbackSent = 0;
          let holdbackFailed = 0;

          for (const msg of holdbackMessages) {
            try {
              const respData = await WhatsApp.sendTemplate(
                client, msg.phone, winner.templateName,
                'en', [] // Holdback gets winner template with no custom components
              );
              const metaMsgId = respData?.messages?.[0]?.id;
              msg.messageId = metaMsgId || null;
              msg.status = metaMsgId ? 'sent' : 'failed';
              msg.sentAt = new Date();
              msg.abVariantLabel = `holdout_${winner.label}`;
              await msg.save();
              if (metaMsgId) holdbackSent++;
              else holdbackFailed++;
            } catch (err) {
              msg.status = 'failed';
              msg.errorMessage = err.friendlyMessage || err.message;
              msg.failedAt = new Date();
              await msg.save();
              holdbackFailed++;
            }
            await sleep(MIN_MESSAGE_GAP_MS);
          }

          // Finalize AB campaign
          campaign.abTestConfig.holdbackProcessed = true;
          campaign.sentCount = (campaign.sentCount || 0) + holdbackSent;
          campaign.failedCount = (campaign.failedCount || 0) + holdbackFailed;
          campaign.status = 'COMPLETED';
          await campaign.save();

          log.info(`[CampaignCron] AB Test DONE: ${campaign.name} | holdback_sent=${holdbackSent} holdback_failed=${holdbackFailed}`);
        } catch (abErr) {
          log.error(`[CampaignCron] AB evaluation failed for ${campaign.name}:`, abErr.message);
          campaign.status = 'FAILED';
          await campaign.save().catch(() => {});
        }
      }

      // ─── Phase 3: Normal Scheduled Campaign Dispatch ───
      const nowDispatch = new Date();
      const scheduled = await Campaign.find({
        isAbTest: false,
        $or: [
          {
            status: 'QUEUED',
            $or: [
              { scheduledAt: { $lte: nowDispatch } },
              { scheduledAt: null },
              { scheduledAt: { $exists: false } },
            ],
          },
          { status: 'SCHEDULED', scheduledAt: { $lte: nowDispatch } },
        ],
      });

      for (const campaign of scheduled) {
        try {
          const client = await Client.findOne({ clientId: campaign.clientId });
          if (!client) {
            log.error(`[CampaignCron] Client ${campaign.clientId} not found. Skipping campaign ${campaign.name}.`);
            campaign.status = 'FAILED';
            await campaign.save();
            continue;
          }

          campaign.status = 'SENDING';
          await campaign.save();
          log.info(`[CampaignCron] 🚀 Dispatching scheduled campaign: ${campaign.name}`);

          // Determine audience source
          let phones = campaign.audience || [];

          if (phones.length === 0) {
            if (campaign.segmentId) {
              const Segment = require('../models/Segment');
              const AdLead = require('../models/AdLead');
              const segment = await Segment.findById(campaign.segmentId);
              if (segment) {
                const leads = await AdLead.find({ ...segment.query, clientId: campaign.clientId }).select('phoneNumber name').lean();
                phones = leads.map(l => ({ phone: l.phoneNumber, name: l.name || 'Customer', ...l }));
              }
            } else if (campaign.importBatchId) {
              const AdLead = require('../models/AdLead');
              // Legacy campaigns may have stored the BATCH_* string directly.
              // Always resolve before querying AdLead.importBatchId (ObjectId).
              const resolvedBatchId = await resolveImportBatchObjectId(campaign.importBatchId, campaign.clientId);
              if (!resolvedBatchId) {
                log.error(`[CampaignCron] Campaign ${campaign.name} references missing import batch (${campaign.importBatchId}). Marking FAILED.`);
                campaign.status = 'FAILED';
                campaign.autoPaused = true;
                campaign.autoPausedReason = 'Imported list no longer exists';
                await campaign.save();
                continue;
              }
              const leads = await AdLead.find({ importBatchId: resolvedBatchId, clientId: campaign.clientId }).select('phoneNumber name').lean();
              phones = leads.map(l => ({ phone: l.phoneNumber, name: l.name || 'Customer', ...l }));
            }
          }

          if (phones.length === 0) {
            log.warn(`[CampaignCron] No audience found for campaign ${campaign.name}. Marking COMPLETED.`);
            campaign.status = 'COMPLETED';
            campaign.audienceCount = 0;
            await campaign.save();
            continue;
          }

          const tName = campaign.templateName;
          let sent = 0; let failed = 0;

          const ioStart = global.io;
          if (ioStart) {
            ioStart.to(`client_${campaign.clientId}`).emit('campaign:started', {
              campaignId: campaign._id,
              total: phones.length,
              at: new Date().toISOString(),
            });
          }

          for (let idx = 0; idx < phones.length; idx++) {
            const row = phones[idx];
            const { phone, name } = row;
            const cmDoc = await CampaignMessage.create({
              campaignId: campaign._id,
              clientId: campaign.clientId,
              phone,
              status: 'queued'
            });

            try {
              let components = campaign.templateComponents ? JSON.parse(JSON.stringify(campaign.templateComponents)) : [];

              if (campaign.variableMapping && Object.keys(campaign.variableMapping).length > 0) {
                const bodyParams = [];
                const sortedKeys = Object.keys(campaign.variableMapping).sort((a, b) => parseInt(a) - parseInt(b));
                sortedKeys.forEach((k) => {
                  const dataField = campaign.variableMapping[k];
                  let val = row[dataField] || row.capturedData?.[dataField] || '';
                  if (dataField === 'name') val = row.name || 'Customer';
                  bodyParams.push({ type: 'text', text: String(val || '-') });
                });
                if (bodyParams.length > 0) {
                  const existingBodyIndex = components.findIndex(c => c.type === 'body');
                  if (existingBodyIndex !== -1) {
                    components[existingBodyIndex].parameters = bodyParams;
                  } else {
                    components.push({ type: 'body', parameters: bodyParams });
                  }
                }
              }

              if (components.length === 0 && (!campaign.variableMapping || Object.keys(campaign.variableMapping).length === 0)) {
                const tplDef = (client.syncedMetaTemplates || []).find(t => t.name === tName);
                if (tplDef) {
                  const bodyComp = tplDef.components?.find(c => c.type === 'BODY');
                  if (bodyComp?.text) {
                    const paramMatches = bodyComp.text.match(/{{(\d+)}}/g) || [];
                    const paramCount = paramMatches.length > 0 ? Math.max(...paramMatches.map(m => parseInt(m.match(/\d+/)[0]))) : 0;
                    if (paramCount > 0) {
                      const params = [];
                      for (let pi = 1; pi <= paramCount; pi++) {
                        params.push({ type: 'text', text: pi === 1 ? (row.name || 'Customer') : '-' });
                      }
                      components.push({ type: 'body', parameters: params });
                    }
                  }
                }
              }

              let respData;
              if (components && components.length > 0) {
                respData = await WhatsApp.sendTemplate(client, phone, tName, campaign.languageCode || 'en', components);
              } else {
                respData = await WhatsApp.sendSmartTemplate(client, phone, tName, [name]);
              }

              const metaMsgId = respData?.messages?.[0]?.id;
              cmDoc.messageId = metaMsgId || null;
              cmDoc.status = metaMsgId ? 'sent' : 'failed';
              cmDoc.sentAt = new Date();
              await cmDoc.save();
              if (metaMsgId) sent++;
              else failed++;
            } catch (err) {
              cmDoc.status = 'failed';
              cmDoc.errorMessage = err.friendlyMessage || err.message;
              cmDoc.failedAt = new Date();
              await cmDoc.save();
              failed++;
            }

            const currentSent = sent + failed;
            const io = global.io;
            if (io && (currentSent % 100 === 0 || currentSent === phones.length)) {
              io.to(`client_${campaign.clientId}`).emit('campaign:progress', {
                campaignId: campaign._id,
                sent,
                failed,
                total: phones.length,
                progress: Math.round((currentSent / phones.length) * 100),
              });
              io.to(`client_${campaign.clientId}`).emit('campaign_progress', {
                campaignId: campaign._id,
                sent: currentSent,
                total: phones.length,
                progress: Math.round((currentSent / phones.length) * 100),
              });
            }

            if (idx < phones.length - 1) await sleep(MIN_MESSAGE_GAP_MS);
          }

          campaign.sentCount = sent;
          campaign.failedCount = failed;
          campaign.audienceCount = phones.length;
          campaign.status = failed === phones.length ? 'FAILED' : 'COMPLETED';
          await campaign.save();

          const ioDone = global.io;
          if (ioDone) {
            ioDone.to(`client_${campaign.clientId}`).emit('campaign:completed', {
              campaignId: campaign._id,
              sent,
              failed,
              total: phones.length,
            });
          }

          log.info(`[CampaignCron] Campaign DONE: ${campaign.name} | sent=${sent} failed=${failed} total=${phones.length}`);
        } catch (dispatchErr) {
          log.error(`[CampaignCron] Dispatch failed for ${campaign.name}:`, dispatchErr.message);
          campaign.status = 'FAILED';
          await campaign.save().catch(() => {});
        }
      }

    } catch (err) {
      log.error('❌ Error in scheduled campaign cron:', err.message);
    }
  });
};

module.exports = scheduleCampaignCron;
