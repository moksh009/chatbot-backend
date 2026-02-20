const cron = require('node-cron');
const axios = require('axios');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');

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
    // Run every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
        console.log('⏰ Running Abandoned Cart Scheduler...');
        try {
            const now = new Date();
            const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
            const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
            const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

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

                // --- A. Abandonment Detection (2 Hours) ---
                const abandonedLeads = await AdLead.find({
                    clientId: client.clientId,
                    cartStatus: 'active',
                    'cartSnapshot.items.0': { $exists: true },
                    'cartSnapshot.updatedAt': { $lte: twoHoursAgo }
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
                        const templateData = {
                            messaging_product: 'whatsapp',
                            to: lead.phoneNumber,
                            type: 'template',
                            template: {
                                name: 'abandoned_cart_reminder',
                                language: { code: 'en' },
                                components: [
                                    {
                                        type: 'body',
                                        parameters: variables
                                    },
                                    {
                                        type: 'button',
                                        sub_type: 'url',
                                        index: '0',
                                        parameters: [{ type: 'text', text: lead._id.toString() }]
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
                                        details: 'Sent abandoned_cart_reminder template',
                                        timestamp: new Date(),
                                        meta: {}
                                    }
                                }
                            });
                        } else {
                            // Failure handler: keep as active but log failure so it can be monitored
                            await AdLead.findByIdAndUpdate(lead._id, {
                                $push: {
                                    activityLog: {
                                        action: 'whatsapp_failed',
                                        details: 'Failed to send abandoned_cart_reminder template (silent killer caught)',
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

                // --- B. Admin Follow-Up (3-4 Hours After Reminder) ---
                const followupLeads = await AdLead.find({
                    clientId: client.clientId,
                    cartStatus: 'abandoned',
                    adminFollowUpTriggered: false,
                    abandonedCartReminderSentAt: { $lt: threeHoursAgo, $gte: fourHoursAgo }
                });

                for (const lead of followupLeads) {
                    try {
                        if (!adminPhone) continue;

                        let cartValue = 0; // if price is stored
                        // Calculate price if available from prices or default to 0
                        // Alternatively just list handles/titles
                        const items = lead.cartSnapshot?.titles?.join(', ') || 'Unknown items';
                        const timeSince = Math.round((new Date() - lead.lastInteraction) / (1000 * 60 * 60));

                        const message = `⚠️ *Abandoned Cart Alert*\nCustomer: ${lead.name || 'Unknown'}\nPhone: +${lead.phoneNumber}\nProducts: ${items}\nCart Value: ₹${cartValue}\nLast activity: ${timeSince} hours ago\n👉 Call customer now: https://wa.me/${lead.phoneNumber}`;

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
