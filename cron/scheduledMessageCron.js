const cron = require('node-cron');
const ScheduledMessage = require('../models/ScheduledMessage');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const { sendWhatsAppText, sendWhatsAppTemplate } = require('../utils/whatsappHelpers');
const { sendInstagramDM } = require('../utils/instagramApi');

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
                        // e.g. cancelIf: { linkClicked: true }
                        let shouldCancel = false;
                        for (const [key, value] of Object.entries(msg.cancelIf)) {
                            if (lead[key] === value || (key === 'linkClicked' && lead.linkClicks > 0)) {
                                shouldCancel = true;
                                break;
                            }
                        }
                        if (shouldCancel) {
                            console.log(`[ScheduledMessageCron] Cancelling message for ${msg.phone} due to cancelIf condition.`);
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
                                token: token
                            });
                            sentSuccess = res.success;
                        } else {
                            const res = await sendWhatsAppText({
                                phoneNumberId: phoneId,
                                to: msg.phone,
                                body: msg.content.text || msg.content,
                                token: token
                            });
                            sentSuccess = res.success;
                        }
                    } else if (msg.channel === 'instagram') {
                        const token = client.instagramAccessToken;
                        if (token) {
                            await sendInstagramDM(msg.phone, { text: msg.content.text || msg.content }, token);
                            sentSuccess = true;
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
