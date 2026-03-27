const cron = require('node-cron');
const axios = require('axios');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const DailyStat = require('../models/DailyStat');
const { sendAbandonedCartEmail } = require('../utils/emailService');
const log = require('../utils/logger')('AbandonedCart');
const { generateText } = require('../utils/gemini');

// Helper to check if a specific node role was handled previously
const wasRoleHandled = (lead, role) => lead.activityLog.some(l => l.action === 'automation_nudge' && l.details === role);

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
    // 1. Abandoned Cart Scheduler - Runs every 5 minutes for better 15m precision
    cron.schedule('*/5 * * * *', async () => {
        log.info('Abandoned cart cron tick — checking for recoverable leads...');
        try {
            const now = new Date();
            const fifteenMinsAgo = new Date(now - 15 * 60 * 1000);
            const twoHoursAgo  = new Date(now - 2 * 60 * 60 * 1000);
            const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
            const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

            // --- Step 0: Browse Abandonment (30 mins, viewed product but no cart) ---
            const browseBatch = await AdLead.find({
                clientId: { $exists: true },
                isOrderPlaced: { $ne: true },
                addToCartCount: 0,
                linkClicks: { $gt: 0 },
                recoveryStep: { $exists: false },
                updatedAt: { $lte: new Date(now - 30 * 60 * 1000), $gte: sevenDaysAgo }
            }).limit(50);
            log.info(`Step 0 (Browse) batch size: ${browseBatch.length}`);

            for (const lead of browseBatch) {
                const client = await Client.findOne({ clientId: lead.clientId });
                if (!client) continue;
                const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
                const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
                if (!token || !phoneId) continue;

                const lastClick = lead.activityLog
                    .filter(l => l.action === "link_click")
                    .sort((a, b) => b.timestamp - a.timestamp)[0];
                
                const productName = lastClick ? lastClick.details.replace('clicked product ', '') : "something amazing";
                const msg = `Hi ${lead.name || 'there'}! 👋 We noticed you checking out *${productName}*. Need any help with it? We're here to answer any questions! 😊`;
                
                await sendWhatsAppText(token, phoneId, lead.phoneNumber, msg);
                await AdLead.findByIdAndUpdate(lead._id, { 
                    recoveryStep: 0, 
                    $push: { activityLog: { action: 'automation_nudge', details: 'browse_abandon', timestamp: new Date() } }
                });

                // Update stats
                const today = new Date().toISOString().split('T')[0];
                await DailyStat.findOneAndUpdate(
                    { clientId: lead.clientId, date: today },
                    { $inc: { browseAbandonedCount: 1 }, $setOnInsert: { clientId: lead.clientId, date: today } },
                    { upsert: true }
                );
            }

            // --- Step 1: First recovery message (15 mins) ---
            const step1Batch = await AdLead.find({
                clientId: { $exists: true },
                isOrderPlaced: { $ne: true },
                addToCartCount: { $gt: 0 }, 
                recoveryStep: { $in: [null, 0] },
                updatedAt: { $lte: fifteenMinsAgo, $gte: sevenDaysAgo }
            }).limit(100);
            log.info(`Step 1 (15m) batch size: ${step1Batch.length}`);

            for (const lead of step1Batch) {
                const client = await Client.findOne({ clientId: lead.clientId });
                if (!client) continue;

                const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
                const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;

                if (!token || !phoneId) continue;

                const lastCart = lead.activityLog
                    .filter(l => l.action === "add_to_cart")
                    .sort((a, b) => b.timestamp - a.timestamp)[0];
                
                if (!lastCart) continue;
                
                const hasOrdered = lead.activityLog.some(l => l.action === "order_placed");
                if (hasOrdered) continue;

                const storeUrl = client.nicheData?.storeUrl || process.env.STORE_URL || 'https://example.com';
                const restoreUrl = `${storeUrl}/cart`;
                const customMsg = client.nicheData?.abandonedMsg1;

                if (customMsg) {
                    const discountCode = client.nicheData?.globalDiscountCode || "OFF10";
                    const personalizedMsg = customMsg
                        .replace(/{name}/g, lead.name || "there")
                        .replace(/{items}/g, lead.activityLog.filter(l => l.action === 'add_to_cart').map(l => l.details).join(', '))
                        .replace(/{discount_code}/g, discountCode);
                    
                    await sendWhatsAppText(token, phoneId, lead.phoneNumber, personalizedMsg);
                } else {
                    await sendWhatsAppTemplate(
                        token,
                        phoneId,
                        lead.phoneNumber,
                        "cart_remainder",
                        [{ type: "text", text: lead.name || "Customer" }]
                    );
                }

                if (lead.email) {
                    await sendAbandonedCartEmail(client, {
                        customerEmail: lead.email,
                        customerName: lead.name || 'Customer',
                        cartLink: `${client.nicheData?.storeUrl || process.env.STORE_URL || restoreUrl}/cart`,
                        items: lead.activityLog
                            .filter(l => l.action === 'add_to_cart')
                            .map(l => ({ name: l.details || 'Product' }))
                    });
                }

                await AdLead.findByIdAndUpdate(lead._id, { 
                    recoveryStep: 1, 
                    recoveryStartedAt: new Date(),
                    $push: { activityLog: { action: 'automation_nudge', details: 'cart_1', timestamp: new Date() } }
                });

                const today = new Date().toISOString().split('T')[0];
                await DailyStat.findOneAndUpdate(
                    { clientId: lead.clientId, date: today },
                    { $inc: { cartRecoveryMessagesSent: 1 }, $setOnInsert: { clientId: lead.clientId, date: today } },
                    { upsert: true }
                );
            }

            // --- Step 2: Negotiator message (2 hours, no purchase) ---
            const step2Batch = await AdLead.find({
                clientId: { $exists: true }, // Ensure safety
                recoveryStep: 1,
                recoveryStartedAt: { $lte: twoHoursAgo },
                isOrderPlaced: { $ne: true }
            });
            log.info(`Step 2 (2h) batch size: ${step2Batch.length}`);

            for (const lead of step2Batch) {
                const client = await Client.findOne({ clientId: lead.clientId });
                if (!client) continue;

                // Feature Tiering Gate: V1 Clients do NOT get the AI Negotiator Message
                if (client.plan === 'CX Agent (V1)') {
                    await AdLead.findByIdAndUpdate(lead._id, { recoveryStep: 2 }); // complete
                    continue;
                }

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

                const aiPromptContext = client.nicheData?.aiPromptContext || `You are a friendly sales assistant for ${client.name || 'our ecommerce store'}.`;
                
                const aiPrompt = `
${aiPromptContext}
A customer named ${lead.name || "there"} added ${cartProductName} to their cart but hasn't bought yet.

Write ONE short WhatsApp message (max 3 sentences) that:
1. Mentions the specific product by name (if available)
2. Offers a genuine reason to buy today (like a fast shipping promise, or mentions it's top-rated)
3. Ends with a question to re-engage them

Be conversational, not salesy. No emojis overload. Sound human. Do not use asterisks for bolding.
`;

                const aiResponse = await generateText(aiPrompt, apiKey);
                
                // Feature 2: Dynamic Discount Code
                let discountLine = '';
                const dynamicDiscountsEnabled = (client.automationFlows || []).find(f => f.id === 'dynamic_discounts')?.isActive;
                const discountPercent = (client.automationFlows || []).find(f => f.id === 'dynamic_discounts')?.config?.discountPercent || 10;
                if (dynamicDiscountsEnabled && client.shopifyAccessToken) {
                    try {
                        const codeSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
                        const code = `COMEBACK-${codeSuffix}`;
                        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                        const priceRuleRes = await axios.post(
                            `https://${client.shopDomain}/admin/api/2024-01/price_rules.json`,
                            { price_rule: { title: code, target_type: 'line_item', target_selection: 'all', allocation_method: 'across', value_type: 'percentage', value: `-${discountPercent}`, customer_selection: 'all', starts_at: new Date().toISOString(), ends_at: expiresAt, usage_limit: 1, once_per_customer: true } },
                            { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
                        );
                        await axios.post(
                            `https://${client.shopDomain}/admin/api/2024-01/price_rules/${priceRuleRes.data.price_rule.id}/discount_codes.json`,
                            { discount_code: { code } },
                            { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
                        );
                        discountLine = `\n\n🎁 Here's a *${discountPercent}% off* code just for you: *${code}* (expires in 24 hours, one use only!)`;
                    } catch(discErr) { console.warn('[AbandonedCart] Dynamic discount failed:', discErr.message); }
                } else {
                    const staticCode = client.nicheData?.globalDiscountCode || 'OFF10';
                    discountLine = `\n\n🎁 Use code *${staticCode}* for a special discount!`;
                }

                if (!aiResponse) {
                    await sendWhatsAppText(token, phoneId, lead.phoneNumber, `Hi! Don't forget you left something amazing in your cart. Grab it before it's gone!${discountLine}`);
                } else {
                    await sendWhatsAppText(token, phoneId, lead.phoneNumber, aiResponse + discountLine);
                }

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

                // Feature 5: Order Tagging — tag the order in Shopify after WhatsApp recovery
                // This is done in the webhook handler when order is confirmed
                await AdLead.findByIdAndUpdate(lead._id, { recoveryStep: 2, recoveryStartedAt: new Date() });
            }

            // --- Step 3: Final Nudge (24 hours, no purchase) ---
            const step3Batch = await AdLead.find({
                clientId: { $exists: true },
                recoveryStep: 2,
                recoveryStartedAt: { $lte: twentyFourHoursAgo },
                isOrderPlaced: { $ne: true }
            });
            log.info(`Step 3 (24h) batch size: ${step3Batch.length}`);

            for (const lead of step3Batch) {
                const client = await Client.findOne({ clientId: lead.clientId });
                if (!client) continue;

                const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
                const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
                if (!token || !phoneId) continue;

                const hasOrdered = lead.activityLog.some(l => l.action === "order_placed");
                if (hasOrdered) {
                    await AdLead.findByIdAndUpdate(lead._id, { recoveryStep: 3 });
                    continue;
                }

                const discountCode = client.nicheData?.globalDiscountCode || "OFF10";
                const customMsg = client.nicheData?.abandonedMsg2 || `🚨 Final Reminder, {name}! Your cart is about to expire. Use code {discount_code} to save. Complete your order now! 🛒`;
                
                const personalizedMsg = customMsg
                    .replace(/{name}/g, lead.name || 'friend')
                    .replace(/{discount_code}/g, discountCode);

                await sendWhatsAppText(token, phoneId, lead.phoneNumber, personalizedMsg);
                await AdLead.findByIdAndUpdate(lead._id, { recoveryStep: 3 });
            }

            // --- Step 4: Post-Purchase Cross-sell (1 hour after order) ---
            const step4Batch = await AdLead.find({
                clientId: { $exists: true },
                isOrderPlaced: true,
                recoveryStep: { $in: [1, 2, 3, null, 10] }, 
                lastInteraction: { $lte: new Date(now - 1 * 60 * 60 * 1000) }
            }).limit(50);
            log.info(`Step 4 (Upsell) batch size: ${step4Batch.length}`);

            for (const lead of step4Batch) {
                const client = await Client.findOne({ clientId: lead.clientId });
                if (!client || !client.nicheData?.products?.length) continue;
                if (wasRoleHandled(lead, 'upsell_1')) {
                    await AdLead.findByIdAndUpdate(lead._id, { recoveryStep: 11 }); 
                    continue;
                }

                const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
                const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
                if (!token || !phoneId) continue;

                const mainProducts = client.nicheData.products;
                const randomItem = mainProducts[Math.floor(Math.random() * mainProducts.length)];
                const msg = `Hope you're excited for your order, ${lead.name || 'friend'}! 🎉 Many customers who bought that also loved our *${randomItem.title || randomItem.name}*. Want to add it to your fleet? See here: ${randomItem.url || ''}`;

                await sendWhatsAppText(token, phoneId, lead.phoneNumber, msg);
                await AdLead.findByIdAndUpdate(lead._id, { 
                    recoveryStep: 11,
                    $push: { activityLog: { action: 'automation_nudge', details: 'upsell_1', timestamp: new Date() } }
                });

                // Update stats
                const today = new Date().toISOString().split('T')[0];
                await DailyStat.findOneAndUpdate(
                    { clientId: lead.clientId, date: today },
                    { $inc: { upsellSentCount: 1 }, $setOnInsert: { clientId: lead.clientId, date: today } },
                    { upsert: true }
                );
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

