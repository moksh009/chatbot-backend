const cron = require('node-cron');
const axios = require('axios');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const DailyStat = require('../models/DailyStat');

// Function to send WhatsApp template
async function sendWhatsAppTemplate(token, phoneId, to, templateName, variables) {
    try {
        const data = {
            messaging_product: 'whatsapp',
            to: to,
            type: 'template',
            template: {
                name: templateName,
                language: { code: 'en' },
                components: [
                    {
                        type: 'body',
                        parameters: variables
                    }
                ]
            }
        };

        await axios.post(
            `https://graph.facebook.com/v18.0/${phoneId}/messages`,
            data,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        return true;
    } catch (error) {
        console.error("WhatsApp Template Error:", error.response?.data || error.message);
        return false;
    }
}

// Function to send WhatsApp Text to admin
async function sendWhatsAppText(token, phoneId, to, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${phoneId}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: { body: text }
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        return true;
    } catch (error) {
        console.error("WhatsApp Text Error:", error.response?.data || error.message);
        return false;
    }
}

const scheduleAbandonedCartCron = () => {
    // Run every 1 minute
    cron.schedule('* * * * *', async () => {
        console.log('⏰ Running Abandoned Cart Scheduler...');
        try {
            const now = new Date();
            const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
            const sixMinutesAgo = new Date(now.getTime() - 6 * 60 * 1000);
            const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

            // Get all ecommerce clients to get their credentials
            const clients = await Client.find({ businessType: 'ecommerce' });
            if (!clients.length) return;

            for (const client of clients) {
                const envSuffix = `_${client.clientId}`;
                const envToken = process.env[`WHATSAPP_TOKEN${envSuffix}`];
                const globalToken = process.env.WHATSAPP_TOKEN;

                let token = client.whatsappToken || client.config?.whatsappToken;
                if (!token) token = envToken || globalToken;

                const phoneId = client.phoneNumberId || client.config?.phoneNumberId;
                const adminPhone = client.adminPhoneNumber || client.config?.adminPhoneNumber;

                if (!token || !phoneId) {
                    console.warn(`[Cron] Skipping client ${client.clientId} - missing token or phoneId`);
                    continue;
                }

                // --- A. Abandonment Detection (5 Minutes) ---
                const abandonedLeads = await AdLead.find({
                    clientId: client.clientId,
                    cartStatus: 'active',
                    isOrderPlaced: { $ne: true },
                    'cartSnapshot.items.0': { $exists: true },
                    'cartSnapshot.updatedAt': { $lte: fiveMinutesAgo }
                });

                for (const lead of abandonedLeads) {
                    const customerName = lead.name || 'Valued Customer';
                    // Template variables: {{1}} -> Customer name
                    const variables = [
                        { type: 'text', text: customerName } // {{1}}
                    ];

                    // The button URL is usually dynamic per component, or maybe handled by template configuration
                    // Wait, Facebook API templates with dynamic URLs require a button parameter if the URL has a variable tail
                    // Let's pass the uid as the dynamic URL parameter for the button.
                    try {
                        const templateName = 'cart_remainder';

                        // Extract highest quality image from the most recent item added
                        // Fallback assets based on ved.js
                        const ASSETS = {
                            'hero_3mp': 'https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png?v=1760635732&width=1346',
                            'hero_5mp': 'https://delitechsmarthome.in/cdn/shop/files/my1.png?v=1759746759&width=1346'
                        };

                        let imageUrl = ASSETS.hero_3mp; // Default fallback

                        if (lead.cartSnapshot && lead.cartSnapshot.titles) {
                            const titles = lead.cartSnapshot.titles.join(' ').toLowerCase();
                            if (titles.includes('5mp')) {
                                imageUrl = ASSETS.hero_5mp;
                            } else if (titles.includes('3mp') || titles.includes('2mp')) {
                                imageUrl = ASSETS.hero_3mp;
                            } else if (lead.cartSnapshot.items && lead.cartSnapshot.items.length > 0) {
                                // Last resort: try to get image from items snapshot
                                const firstItemWithImage = lead.cartSnapshot.items.find(i => i.image);
                                if (firstItemWithImage && firstItemWithImage.image) {
                                    imageUrl = firstItemWithImage.image.startsWith('//') ? `https:${firstItemWithImage.image}` : firstItemWithImage.image;
                                }
                            }
                        }

                        // Build dynamic product link / cart restore link (Direct Store Link as per user request)
                        const restoreUrlSuffix = `?uid=${lead._id.toString()}&restore=true`;

                        const templateData = {
                            messaging_product: 'whatsapp',
                            to: lead.phoneNumber,
                            type: 'template',
                            template: {
                                name: templateName,
                                language: { code: 'en' },
                                components: [
                                    {
                                        type: 'header',
                                        parameters: [
                                            {
                                                type: 'image',
                                                image: { link: imageUrl }
                                            }
                                        ]
                                    },
                                    {
                                        type: 'body',
                                        parameters: variables
                                    },
                                    {
                                        type: 'button',
                                        sub_type: 'url',
                                        index: '0',
                                        parameters: [
                                            {
                                                type: 'text',
                                                text: restoreUrlSuffix
                                            }
                                        ]
                                    }
                                ]
                            }
                        };

                        let success = false;
                        try {
                            await axios.post(
                                `https://graph.facebook.com/v18.0/${phoneId}/messages`,
                                templateData,
                                { headers: { Authorization: `Bearer ${token}` } }
                            );
                            success = true;
                        } catch (e) {
                            console.error("Cart Reminder Template Error:", e.response?.data || e.message);
                        }

                        if (success) {
                            await AdLead.findByIdAndUpdate(lead._id, {
                                $set: {
                                    cartStatus: 'abandoned',
                                    abandonedCartReminderSentAt: new Date()
                                },
                                $push: {
                                    activityLog: {
                                        action: 'whatsapp_template_sent',
                                        details: 'Sent cart_remainder template',
                                        timestamp: new Date(),
                                        meta: {}
                                    }
                                }
                            });

                            // Increment Daily Stats
                            try {
                                const today = new Date().toISOString().split('T')[0];
                                await DailyStat.updateOne(
                                    { clientId: client.clientId, date: today },
                                    { $inc: { abandonedCartSent: 1 } },
                                    { upsert: true }
                                );
                            } catch (e) { console.error("DailyStat Update Error (Sent):", e); }
                        } else {
                            // Failure handler: mark as failed so it doesn't infinitely loop
                            await AdLead.findByIdAndUpdate(lead._id, {
                                $set: {
                                    cartStatus: 'failed'
                                },
                                $push: {
                                    activityLog: {
                                        action: 'whatsapp_failed',
                                        details: 'Failed to send cart_remainder template (silent killer caught)',
                                        timestamp: new Date(),
                                        meta: {}
                                    }
                                }
                            });
                        }
                    } catch (err) {
                        console.error("Failed to process abandoned lead:", err.message);
                    }
                }

                // --- B. Admin Follow-Up (5 Minutes After Reminder) ---
                const followupLeads = await AdLead.find({
                    clientId: client.clientId,
                    cartStatus: { $in: ['abandoned', 'recovered'] },
                    adminFollowUpTriggered: false,
                    abandonedCartReminderSentAt: { $lt: fiveMinutesAgo, $gte: tenMinutesAgo }
                });

                for (const lead of followupLeads) {
                    try {
                        if (!adminPhone) continue;

                        let cartValue = 0; // if price is stored
                        // Calculate price if available from prices or default to 0
                        // Alternatively just list handles/titles
                        const items = lead.cartSnapshot?.titles?.join(', ') || 'Unknown items';
                        const timeSince = Math.round((new Date() - lead.lastInteraction) / (1000 * 60)); // Changed to minutes

                        const message = `⚠️ *Abandoned Cart Alert*\nCustomer: ${lead.name || 'Unknown'}\nPhone: +${lead.phoneNumber}\nProducts: ${items}\nCart Value: ₹${cartValue}\nLast activity: ${timeSince} minutes ago\n👉 Call customer now: https://wa.me/${lead.phoneNumber}`;

                        const success = await sendWhatsAppText(token, phoneId, adminPhone, message);

                        if (success) {
                            await AdLead.findByIdAndUpdate(lead._id, {
                                $set: { adminFollowUpTriggered: true },
                                $push: {
                                    activityLog: {
                                        action: 'admin_followup_sent',
                                        details: 'Sent follow-up alert to admin',
                                        timestamp: new Date(),
                                        meta: {}
                                    }
                                }
                            });
                        }
                    } catch (err) {
                        console.error("Failed to process followup lead:", err.message);
                    }
                }
            }
        } catch (error) {
            console.error('Error in Abandoned Cart Scheduler:', error);
        }
    });
};

module.exports = scheduleAbandonedCartCron;
