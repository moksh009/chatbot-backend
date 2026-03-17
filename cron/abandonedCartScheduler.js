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
            // Cart Reminder threshold: 1.5 minutes of inactivity (Reduced from 3 for better responsiveness)
            const abandonmentThreshold = new Date(now.getTime() - 1.5 * 60 * 1000);
            
            // Admin Follow-up window: 3 to 10 minutes after the cart reminder was sent
            const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000);
            const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

            // Get all ecommerce clients to get their credentials
            const clients = await Client.find({ businessType: 'ecommerce' });
            if (!clients.length) return;

            for (const client of clients) {
                // ... (existing token/phoneId logic)
                const envSuffix = `_${client.clientId}`;
                const envToken = process.env[`WHATSAPP_TOKEN${envSuffix}`];
                const globalToken = process.env.WHATSAPP_TOKEN;

                let token = client.whatsappToken || client.config?.whatsappToken;
                if (!token) token = envToken || globalToken;

                const phoneId = client.phoneNumberId || client.config?.phoneNumberId;
                let adminPhone = client.adminPhoneNumber || client.config?.adminPhoneNumber;
                
                // Hardcoded fallback for Delitech admin if not in DB
                if (!adminPhone && client.clientId === 'delitech_smarthomes') {
                    adminPhone = '919313045439';
                }

                if (!token || !phoneId) {
                    continue;
                }

                // --- A. Abandonment Detection ---
                const abandonedLeads = await AdLead.find({
                    clientId: client.clientId,
                    cartStatus: 'active',
                    'cartSnapshot.items.0': { $exists: true },
                    'cartSnapshot.updatedAt': { $lte: abandonmentThreshold },
                    abandonedCartReminderSentAt: { $exists: false }
                });

                if (abandonedLeads.length > 0) {
                    console.log(`[Cron] Found ${abandonedLeads.length} abandoned leads for client ${client.clientId}`);
                }

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
                            // Failure handler: Simply log it, don't set invalid status
                            console.error(`[Cron] Failed to send reminder to ${lead.phoneNumber}`);
                        }
                    } catch (err) {
                        console.error("Failed to process abandoned lead:", err.message);
                    }
                }

                // --- B. Admin Follow-Up (6 Minutes After Reminder) ---
                const followupLeads = await AdLead.find({
                    clientId: client.clientId,
                    cartStatus: { $in: ['active', 'abandoned', 'recovered'] },
                    adminFollowUpTriggered: false,
                    abandonedCartReminderSentAt: { $lt: threeMinutesAgo, $gte: tenMinutesAgo }
                });

                for (const lead of followupLeads) {
                    try {
                        if (!adminPhone) continue;

                        let cartValue = lead.cartSnapshot?.total_price || 0;
                        const items = lead.cartSnapshot?.titles?.join(', ') || 'Unknown items';

                        // --- Fallback: If cart value is 0, estimate it from titles (common for partial webhooks) ---
                        if (cartValue === 0 && lead.cartSnapshot?.titles?.length > 0) {
                            lead.cartSnapshot.titles.forEach(title => {
                                if (title.includes('5MP')) cartValue += 6999;
                                else if (title.includes('3MP')) cartValue += 6499;
                                else if (title.includes('2MP')) cartValue += 5499;
                            });
                        }

                        const minutesSince = Math.round((new Date() - lead.lastInteraction) / (1000 * 60));
                        
                        let timeSinceFormatted = `${minutesSince} mins`;
                        if (minutesSince > 60) {
                            timeSinceFormatted = `${Math.floor(minutesSince / 60)} hrs, ${minutesSince % 60} mins`;
                        }

                        const customerName = lead.name || 'Unknown';

                        const message = `⚠️ *Abandoned Cart Alert*\nWe have sent them a card recovery message still they have not purchased. Contact them now!\n\nCustomer: ${customerName}\nPhone: +${lead.phoneNumber}\nProducts: ${items}\nCart Value: ₹${cartValue.toLocaleString()}\nLast activity: ${timeSinceFormatted} ago\n👉 Call customer now: https://wa.me/${lead.phoneNumber}`;

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
