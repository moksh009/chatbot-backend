const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const AdLead = require('../models/AdLead');
const Segment = require('../models/Segment');
const Client = require('../models/Client');
const Message = require('../models/Message');
const WhatsApp = require('./whatsapp');
const { sendBirthdayWishWithImage } = require('./sendBirthdayMessage');
const { sendAppointmentReminder } = require('./sendAppointmentReminder');
const log = require('./logger')('BroadcastEngine');
const { incrementStat } = require('./statCacheEngine');

function normalizePhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/[^\d]/g, '');
  if (!digits) return '';
  const cc = process.env.DEFAULT_COUNTRY_CODE || '91';
  if (digits.length === 10) return cc + digits;
  return digits;
}

async function processBroadcast(data) {
    const { campaignId, clientId, templateType, templateName, templateComponents, variableMapping, languageCode, isAbTest, abTestConfig, templateTypeB } = data;
    log.info(`[BroadcastEngine] Processing large campaign: ${campaignId}`);

    try {
        const campaign = await Campaign.findById(campaignId);
        if (!campaign) throw new Error('Campaign not found');

        const client = await Client.findOne({ clientId });
        if (!client) throw new Error('Client not found');

        let query = {};
        if (campaign.segmentId) {
            const segment = await Segment.findById(campaign.segmentId);
            if (!segment) throw new Error('Segment not found');
            query = segment.query;
        } else if (campaign.importBatchId) {
            query = { importBatchId: campaign.importBatchId };
        } else {
            throw new Error('No valid audience source attached to campaign');
        }

        let total = 0;
        let sent = 0;
        let failed = 0;
        
        let actualTemplateName = null;
        if (templateType === 'birthday') {
            actualTemplateName = client.config?.templates?.birthday || 'happy_birthday_wish_1';
        } else if (templateType === 'appointment') {
            actualTemplateName = client.config?.templates?.appointment || 'appointment_reminder_1';
        }

        // We use .lean().cursor() to stream leads instead of pulling 50k+ into memory
        const cursor = AdLead.find({ ...query, clientId }).lean().cursor();
        const lastSentMap = new Map();
        
        for await (const lead of cursor) {
            total++;
            const recipientPhone = normalizePhone(lead.phoneNumber);
            if (!recipientPhone) { failed++; continue; }

            const lastSentTime = lastSentMap.get(recipientPhone);
            if (lastSentTime && Date.now() - lastSentTime < 1000) {
                const delay = 1000 - (Date.now() - lastSentTime);
                await new Promise(r => setTimeout(r, delay));
            }
            lastSentMap.set(recipientPhone, Date.now());

            let targetTemplateName = templateName || campaign.templateName;
            
            // Note: AB Test streaming logic is simplified here (no strict array splitting)
            // Just round-robin or skip holdback
            let variantLabel = null;
            if (isAbTest) {
               // Simplified random assignment for streamed massive lists
               const rand = Math.random() * 100;
               if (rand < (abTestConfig?.testSizePercentage || 10)) variantLabel = 'A';
               else if (rand < (abTestConfig?.testSizePercentage || 10) * 2) {
                   variantLabel = 'B';
                   targetTemplateName = templateTypeB;
               } else {
                   // Holdout
                   await CampaignMessage.create({
                       campaignId: campaign._id,
                       clientId,
                       phone: recipientPhone,
                       status: 'queued',
                       abVariantLabel: 'holdout',
                       metadata: lead
                   });
                   continue;
               }
            }

            try {
                if (templateType === 'birthday') {
                    const resp = await sendBirthdayWishWithImage(recipientPhone, null, null, clientId, actualTemplateName);
                    if (resp?.success) sent++; else failed++;
                } else if (templateType === 'appointment') {
                    const appointmentDetails = {
                        summary: `Appointment: ${lead.name || 'Patient'} - Service`,
                        doctor: '', date: '', time: ''
                    };
                    await sendAppointmentReminder(null, null, recipientPhone, appointmentDetails, clientId, actualTemplateName);
                    sent++;
                } else if (templateType === 'whatsapp') {
                    const tName = templateName || campaign.templateName;
                    if (!tName) { failed++; continue; }
                    const components = templateComponents ? JSON.parse(JSON.stringify(templateComponents)) : [];
                    
                    if (variableMapping && Object.keys(variableMapping).length > 0) {
                        const bodyParams = [];
                        const sortedKeys = Object.keys(variableMapping).sort((a,b) => parseInt(a) - parseInt(b));
                        sortedKeys.forEach(vIndex => {
                            const dataField = variableMapping[vIndex];
                            let val = '';

                            if (dataField === 'customText') {
                                val = (data?.customTextValues && data.customTextValues[vIndex]) || '';
                            } else if (dataField === 'businessName') {
                                val = client.businessName || client.name || 'Our Store';
                            } else if (dataField === 'lastOrderDate') {
                                val = lead.lastPurchaseDate ? new Date(lead.lastPurchaseDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A';
                            } else if (dataField === 'lastOrderValue') {
                                val = lead.totalSpent ? `₹${lead.totalSpent.toLocaleString('en-IN')}` : '₹0';
                            } else if (dataField === 'tags') {
                                val = Array.isArray(lead.tags) ? lead.tags.join(', ') : '';
                            } else {
                                val = lead[dataField] || lead.capturedData?.[dataField] || '';
                                if (dataField === 'name' && !val) val = 'Customer';
                            }

                            bodyParams.push({ type: 'text', text: String(val).slice(0, 1000) });
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

                    if (components.length === 0 && (!variableMapping || Object.keys(variableMapping).length === 0)) {
                        const tplDef = (client.syncedMetaTemplates || []).find(t => t.name === tName);
                        if (tplDef) {
                            const headerComp = tplDef.components?.find(c => c.type === 'HEADER' && c.format === 'IMAGE');
                            if (headerComp) {
                                const imgUrl = headerComp.example?.header_handle?.[0] || 'https://images.unsplash.com/photo-1577563908411-5077b6dc7624?q=80&w=2070&auto=format&fit=crop';
                                components.push({ type: 'header', parameters: [{ type: 'image', image: { link: imgUrl } }] });
                            }
                            const bodyComp = tplDef.components?.find(c => c.type === 'BODY');
                            if (bodyComp?.text?.includes('{{1}}')) {
                                components.push({ type: 'body', parameters: [{ type: 'text', text: lead.name || 'Customer' }] });
                            }
                        }
                    }
                    
                    const respData = await WhatsApp.sendTemplate(client, recipientPhone, targetTemplateName, languageCode || 'en', components);
                    const metaMsgId = respData?.messages?.[0]?.id || respData?.id;

                    if (metaMsgId) {
                        await CampaignMessage.create({
                            campaignId: campaign._id,
                            clientId,
                            phone: recipientPhone,
                            messageId: metaMsgId,
                            status: 'sent',
                            sentAt: new Date(),
                            abVariantLabel: variantLabel
                        });
                        sent++;
                        
                        const incQuery = { sentCount: 1 };
                        if (variantLabel) incQuery[`abVariants.$[variant].sentCount`] = 1;
                        
                        await Campaign.findByIdAndUpdate(campaign._id, { $inc: incQuery }, variantLabel ? { arrayFilters: [{ 'variant.label': variantLabel }] } : {});
                    } else {
                        failed++;
                        await Campaign.findByIdAndUpdate(campaign._id, { $inc: { failedCount: 1 } });
                    }

                    await Message.create({
                        clientId,
                        from: client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID,
                        to: recipientPhone,
                        direction: 'outgoing',
                        type: 'template',
                        content: `[Campaign: ${campaign.name}] Template: ${tName}`,
                        messageId: metaMsgId,
                        status: 'sent',
                        campaignId: campaign._id,
                        channel: 'whatsapp'
                    });
                }
                // Small sleep to prevent rate limiting issues inside cursor
                await new Promise(r => setTimeout(r, 200));
            } catch (err) {
                failed++;
            }
        }

        campaign.stats.sent = (campaign.stats.sent || 0) + sent;
        campaign.audienceCount = total;
        campaign.status = 'COMPLETED';
        await campaign.save();
        
        if (sent > 0) {
            await incrementStat(clientId, { totalConversations: sent });
        }

        log.success(`[BroadcastEngine] Finished campaign: ${campaignId} | sent=${sent} failed=${failed} total=${total}`);

    } catch (err) {
        log.error(`[BroadcastEngine] Failed campaign: ${campaignId}`, err);
        try {
            await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'FAILED' } });
        } catch {}
        throw err;
    }
}

module.exports = { processBroadcast };
