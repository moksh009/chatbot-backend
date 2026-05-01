const cron = require('node-cron');
const ScheduledMessage = require('../models/ScheduledMessage');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const { sendWhatsAppText, sendWhatsAppTemplate } = require('../utils/whatsappHelpers');
const { sendInstagramDM } = require('../utils/instagramApi');
const { decrypt } = require('../utils/encryption');

module.exports = () => {
    // Run every 2 minutes
    cron.schedule('*/2 * * * *', async () => {
        const now = new Date();
        console.log(`[ScheduledMessageCron] Checking for pending messages at ${now.toISOString()}`);

        try {
            // Find all pending messages where sendAt <= now
            const pendingMessages = await ScheduledMessage.find({
                status: 'pending',
                sendAt: { $lte: now }
            }).populate('clientId');

            if (pendingMessages.length === 0) return;

            console.log(`[ScheduledMessageCron] Found ${pendingMessages.length} messages to process.`);

            for (const msg of pendingMessages) {
                const client = msg.clientId;
                if (!client) {
                    await ScheduledMessage.findByIdAndUpdate(msg._id, { status: 'failed', content: { ...msg.content, error: 'Client not found' } });
                    continue;
                }

                // Check cancelIf conditions
                if (msg.cancelIf) {
                    const lead = await AdLead.findOne({ phoneNumber: msg.phone, clientId: client._id || client.clientId });
                    if (lead) {
                        let shouldCancel = false;
                        
                        // 1. Cancel if user replied after message was scheduled
                        if (msg.cancelIf.userReplied && lead.lastInteraction > msg.createdAt) {
                            shouldCancel = true;
                        }

                        // 2. Cancel if link was clicked
                        if (msg.cancelIf.linkClicked && lead.linkClicks > 0) {
                            shouldCancel = true;
                        }

                        // 3. Dynamic field checks
                        for (const [key, value] of Object.entries(msg.cancelIf)) {
                            if (key !== 'userReplied' && key !== 'linkClicked' && lead[key] === value) {
                                shouldCancel = true;
                                break;
                            }
                        }

                        if (shouldCancel) {
                            console.log(`[ScheduledMessageCron] 🚫 Cancelling message for ${msg.phone} (ID: ${msg._id}) due to 'cancelIf' trigger.`);
                            await ScheduledMessage.findByIdAndUpdate(msg._id, { status: 'cancelled' });
                            continue;
                        }
                    }
                }

                // Send the message
                let sentSuccess = false;
                try {
                    if (msg.channel === 'whatsapp') {
                        const token = client.whatsappToken;
                        const phoneId = client.phoneNumberId;
                        
                        if (msg.messageType === 'template') {
                            const res = await sendWhatsAppTemplate({
                                phoneNumberId: phoneId,
                                to: msg.phone,
                                templateName: msg.content.templateName,
                                languageCode: msg.content.languageCode || 'en_US',
                                components: msg.content.components || [],
                                token: token,
                                clientId: client.clientId || client._id
                            });
                            sentSuccess = res.success;
                        } else {
                            const res = await sendWhatsAppText({
                                phoneNumberId: phoneId,
                                to: msg.phone,
                                body: msg.content.text || msg.content,
                                token: token,
                                clientId: client.clientId || client._id
                            });
                            sentSuccess = res.success;
                        }
                    } else if (msg.channel === 'instagram') {
                        const rawToken = client.instagramAccessToken;
                        if (rawToken) {
                            const token = decrypt(rawToken);
                            await sendInstagramDM(msg.phone, { text: msg.content.text || msg.content }, token);
                            sentSuccess = true;
                        }
                    } else if (msg.channel === 'email') {
                        const emailService = require('../utils/emailService');
                        const emailIntegration = require('../utils/emailIntegration');
                        
                        const { subject, body, toEmail } = msg.content;
                        if (client.resendApiKey && client.emailIdentity) {
                            await emailIntegration.sendEmailMessage(client, toEmail || msg.phone, subject, body, `<div>${body.replace(/\n/g, '<br/>')}</div>`);
                            sentSuccess = true;
                        } else {
                            sentSuccess = await emailService.sendEmail(client, {
                                to: toEmail || msg.phone,
                                subject,
                                html: `<div>${body.replace(/\n/g, '<br/>')}</div>`
                            });
                        }
                    }
                } catch (sendErr) {
                    console.error(`[ScheduledMessageCron] Error sending message to ${msg.phone}:`, sendErr.message);
                }

                await ScheduledMessage.findByIdAndUpdate(msg._id, { 
                    status: sentSuccess ? 'sent' : 'failed'
                });
            }
        } catch (err) {
            console.error('[ScheduledMessageCron] Error:', err.message);
        }
    });
};
