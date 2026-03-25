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

// Gemini API Helper (Moved here for AI Nudge)
async function generateGeminiResponse(apiKey, prompt) {
    if (!apiKey) return "Hi! Don't forget you left something amazing in your cart. Grab it before it's gone!";
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        const data = { contents: [{ parts: [{ text: prompt }] }] };
        const response = await axios.post(url, data, { headers: { 'Content-Type': 'application/json' } });
        return response.data.candidates[0].content.parts[0].text;
    } catch (err) {
        console.error('Gemini API Error (cart_recovery):', err.message);
        return "Hey there! We noticed you left a great item in your cart. Order today to secure it!";
    }
}

const scheduleAbandonedCartCron = () => {
    // 1. Abandoned Cart Scheduler - Runs every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
        console.log('⏰ Running Advanced Abandoned Cart Scheduler...');
        try {
            const now = new Date();
            const twoHoursAgo  = new Date(now - 2 * 60 * 60 * 1000);
            const fourHoursAgo = new Date(now - 4 * 60 * 60 * 1000);
            const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

            // --- Step 1: First recovery message (2 hours) ---
            const firstBatch = await AdLead.find({
                clientId: { $exists: true },
                isOrderPlaced: { $ne: true }, // using boolean flag is safer than activityLog array matches
                recoveryStep: { $exists: false },
                updatedAt: { $lte: twoHoursAgo, $gte: sevenDaysAgo }
            });

            for (const lead of firstBatch) {
                const client = await Client.findOne({ clientId: lead.clientId });
                if (!client) continue;

                const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
                const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;

                if (!token || !phoneId) continue;

                const lastCart = lead.activityLog
                    .filter(l => l.action === "add_to_cart")
                    .sort((a, b) => b.timestamp - a.timestamp)[0];
                
                if (!lastCart) continue;
                
                // Extra check if they naturally purchased
                const hasOrdered = lead.activityLog.some(l => l.action === "order_placed");
                if (hasOrdered) continue;

                const restoreUrl = `${process.env.STORE_URL || 'https://delitechsmarthome.in'}/cart`;

                await sendWhatsAppTemplate(
                    token,
                    phoneId,
                    lead.phoneNumber,
                    "cart_remainder", // Using existing approved template
                    [
                        { type: "text", text: lead.name || "Customer" }
                    ]
                );

                await AdLead.findByIdAndUpdate(lead._id, { 
                    recoveryStep: 1, 
                    recoveryStartedAt: new Date() 
                });

                // Update stats
                const today = new Date().toISOString().split('T')[0];
                await DailyStat.findOneAndUpdate(
                    { clientId: lead.clientId, date: today },
                    { $inc: { cartRecoveryMessagesSent: 1 }, $setOnInsert: { clientId: lead.clientId, date: today } },
                    { upsert: true }
                );
            }

            // --- Step 2: Negotiator message (4 hours, no purchase) ---
            const secondBatch = await AdLead.find({
                clientId: { $exists: true }, // Ensure safety
                recoveryStep: 1,
                recoveryStartedAt: { $lte: fourHoursAgo },
                isOrderPlaced: { $ne: true }
            });

            for (const lead of secondBatch) {
                const client = await Client.findOne({ clientId: lead.clientId });
                if (!client) continue;

                const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
                const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
                const apiKey = client.openaiApiKey || client.config?.geminiApiKey || process.env.GEMINI_API_KEY;

                if (!token || !phoneId) continue;

                const hasOrdered = lead.activityLog.some(l => l.action === "order_placed");
                if (hasOrdered) {
                    await AdLead.findByIdAndUpdate(lead._id, { recoveryStep: 2 }); // complete
                    continue;
                }

                const cartItemAction = lead.activityLog
                    .filter(l => l.action === "add_to_cart")
                    .sort((a, b) => b.timestamp - a.timestamp)[0];

                const cartProductName = cartItemAction ? cartItemAction.details : "a smart doorbell";

                const aiPrompt = `
You are a friendly sales assistant for Delitech Smart Home, a doorbell company.
A customer named ${lead.name || "there"} added ${cartProductName} to their cart but hasn't bought yet.

Write ONE short WhatsApp message (max 3 sentences) that:
1. Mentions the specific product by name (if available)
2. Offers a genuine reason to buy today (like a fast shipping promise, or mentions it's top-rated)
3. Ends with a question to re-engage them

Be conversational, not salesy. No emojis overload. Sound human. Do not use asterisks for bolding.
`;

                const aiResponse = await generateGeminiResponse(apiKey, aiPrompt);
                
                await sendWhatsAppText(
                    token,
                    phoneId,
                    lead.phoneNumber,
                    aiResponse
                );

                // Alert admin
                const adminPhone = client.adminPhoneNumber || client.config?.adminPhoneNumber;
                if (adminPhone) {
                    await sendWhatsAppText(
                        token,
                        phoneId,
                        adminPhone,
                        `🔥 Hot Lead Alert: ${lead.name || lead.phoneNumber} added ${cartProductName} to cart 4hrs ago with no purchase. Check: https://wa.me/91${lead.phoneNumber}`
                    );
                }

                await AdLead.findByIdAndUpdate(lead._id, { recoveryStep: 2 });
            }
        } catch (e) {
            console.error('Abandoned Cart Cron Error:', e);
        }
    });

    // 2. Post-Purchase Review Collection - Runs daily at 10:00 IST (4:30 UTC = 30 4 * * *)
    cron.schedule('30 4 * * *', async () => {
        console.log('⏰ Running Post-Purchase Review Collector...');
        try {
            const ReviewRequest = require('../models/ReviewRequest');
            const dueReviews = await ReviewRequest.find({
                status: "scheduled",
                scheduledFor: { $lte: new Date() }
            });

            for (const review of dueReviews) {
                const client = await Client.findOne({ clientId: review.clientId });
                if (!client) continue;

                const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
                const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;

                if (!token || !phoneId) continue;

                const data = {
                    messaging_product: 'whatsapp',
                    to: review.phone,
                    type: 'interactive',
                    interactive: {
                        type: "button",
                        body: {
                            text: `Hi! How's your *${review.productName}*? 😊\n\nYour feedback genuinely helps us improve and helps other customers make better decisions!`
                        },
                        action: {
                            buttons: [
                                { type: "reply", reply: { id: `rv_good_${review._id}`, title: "😍 Loved it!" } },
                                { type: "reply", reply: { id: `rv_ok_${review._id}`,   title: "😐 It's okay" } },
                                { type: "reply", reply: { id: `rv_bad_${review._id}`,  title: "😕 Not happy" } }
                            ]
                        }
                    }
                };

                try {
                    await axios.post(
                        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
                        data,
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                    
                    await ReviewRequest.findByIdAndUpdate(review._id, { 
                        status: "sent", sentAt: new Date() 
                    });
                } catch (e) {
                    console.error('WhatsApp Review Template Error:', e.response?.data || e.message);
                }
            }
        } catch (e) {
            console.error('Review Cron Error:', e);
        }
    });
};

module.exports = scheduleAbandonedCartCron;

