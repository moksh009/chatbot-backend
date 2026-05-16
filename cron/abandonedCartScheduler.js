const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const DailyStat = require('../models/DailyStat');
const Conversation = require('../models/Conversation');
const { sendAbandonedCartEmail } = require('../utils/emailService');
const { trackEcommerceEvent } = require('../utils/analyticsHelper');
const log = require('../utils/logger')('AbandonedCart');
const { generateText } = require('../utils/gemini');
const WhatsApp = require('../utils/whatsapp');
const { createMessage } = require('../utils/createMessage');
const cron = require('node-cron');
const axios = require('axios');
const {
  mongoCartRecoveryFilter,
  mongoNotOptedOut,
} = require('../utils/marketingConsent');

// Helper to check if a specific node role was handled previously
const wasRoleHandled = (lead, role) => lead.activityLog.some(l => l.action === 'automation_nudge' && l.details === role);

// Outbound message recording helper
async function recordNudge(lead, body, type = 'text') {
    await createMessage({
        clientId: lead.clientId,
        phone: lead.phoneNumber,
        direction: 'outbound',
        type: type,
        body: body,
        metadata: { is_automation_nudge: true }
    });
}

// Phase 9: Batch-aware skip check — avoids N+1 Conversation.findOne per lead
// Build a Set of phones in HUMAN_TAKEOVER for the whole client, then check in O(1)
async function buildSkipSet(clientId) {
    const takeoverConvos = await Conversation.find(
        { clientId, status: 'HUMAN_TAKEOVER' },
        { phone: 1 }
    ).lean();
    return new Set(takeoverConvos.map(c => c.phone));
}

// Legacy wrapper kept for backward compat — replaced by skipSet.has() in batch loops
async function shouldSkipLead(lead) {
    const conv = await Conversation.findOne({ phone: lead.phoneNumber, clientId: lead.clientId });
    if (conv && conv.status === 'HUMAN_TAKEOVER') return true;
    return false;
}

// Universal Rich Nudge Helper
async function sendRichNudge(client, lead, text, options = {}) {
    try {
        const { includeImage, buttons = [], templateName } = options;
        const phone = lead.phoneNumber;

        // 1. Prepare Data
        let imageUrl = null;
        if (includeImage && lead.cartSnapshot?.items?.[0]?.image) {
            imageUrl = lead.cartSnapshot.items[0].image;
        }

        const itemName = lead.cartSnapshot?.items?.[0]?.title || "items in your cart";
        const totalValue = lead.cartSnapshot?.totalPrice ? `₹${lead.cartSnapshot.totalPrice}` : "";
        const checkoutUrl = lead.checkoutUrl || "";

        let successfullySent = false;

        // 2. If Meta Template is configured, use unified templateSender
        if (templateName) {
            log.info(`[Nudge] Sending template ${templateName} to ${phone} via templateSender`);
            try {
                const { sendByName, sendByTrigger } = require('../services/templateSender');
                const cartContext = {
                    cart: {
                        checkout_url: checkoutUrl,
                        total_price: lead.cartSnapshot?.totalPrice,
                        line_items: lead.cartSnapshot?.items || [],
                    },
                    extra: { name: lead.name },
                };
                let result = await sendByTrigger({
                    clientId: client.clientId,
                    phone,
                    trigger: 'abandoned_cart',
                    templateName,
                    contextData: cartContext,
                    email: lead.email,
                });
                if (!result?.whatsapp?.sent) {
                    result = await sendByName({
                        clientId: client.clientId,
                        phone,
                        templateName,
                        contextData: cartContext,
                        email: lead.email,
                    });
                }
                if (result?.whatsapp?.sent) {
                    await recordNudge(lead, `[Template: ${templateName}]`, 'template');
                    successfullySent = true;
                }
            } catch (tplErr) {
                log.warn(`[Nudge] templateSender failed, falling back to sendSmartTemplate: ${tplErr.message}`);
                const variables = [lead.name || 'there', itemName, totalValue, checkoutUrl];
                await WhatsApp.sendSmartTemplate(client, phone, templateName, variables, imageUrl);
                await recordNudge(lead, `[Template: ${templateName}]`, 'template');
                successfullySent = true;
            }
        }
        if (!successfullySent) {
            // 3. Fallback to Interactive/Image/Text
            const activeButtons = buttons.filter(b => b && b.trim()).slice(0, 3).map((b, i) => ({
                type: 'reply',
                reply: { id: `cart_btn_${i}_${lead._id}`, title: b.substring(0, 20) }
            }));

            if (activeButtons.length > 0) {
                const interactive = {
                    type: 'button',
                    header: imageUrl ? { type: 'image', image: { link: imageUrl } } : undefined,
                    body: { text: text },
                    action: { buttons: activeButtons }
                };
                await WhatsApp.sendInteractive(client, phone, interactive, text);
                await recordNudge(lead, `[Interactive: ${text}]`, 'interactive');
                successfullySent = true;
            } else if (imageUrl) {
                await WhatsApp.sendImage(client, phone, imageUrl, text);
                await recordNudge(lead, `[Image: ${text}]`, 'image');
                successfullySent = true;
            } else {
                await WhatsApp.sendText(client, lead.phoneNumber, text);
                await recordNudge(lead, text, 'text');
                successfullySent = true;
            }
        }
        
        if (successfullySent) {
            // --- PART 7: Cart Recovery Attempt Lifecycle - Trigger 2 ---
            try {
                const CartRecoveryAttempt = require('../models/CartRecoveryAttempt');
                await CartRecoveryAttempt.findOneAndUpdate(
                    {
                        clientId: client.clientId,
                        contactPhone: phone,
                        status: 'pending',
                        messaged: false
                    },
                    { $set: { messaged: true, updatedAt: new Date() } },
                    { sort: { attemptTimestamp: -1 } }
                );
            } catch (craErr) {
                log.warn(`[CartRecovery] Failed to mark messaged for ${phone}: ${craErr.message}`);
            }
        }
    } catch (err) {
        const errorMsg = err.friendlyMessage || err.message;
        log.error(`Nudge failed for ${lead.phoneNumber}: ${errorMsg}`);
    }
}

const scheduleAbandonedCartCron = () => {
    // 1. Abandoned Cart Scheduler - Runs every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
        log.info('🚀 Abandoned cart cron tick — processing dynamic recovery steps...');
        try {
            const now = new Date();
            const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

            // Fetch all active clients with automation enabled
            const clients = await Client.find({ 'automationFlows.id': 'abandoned_cart', 'automationFlows.isActive': true });

            for (const client of clients) {
                const niche = client.nicheData || {};

                // ✅ Phase R3: GAP 2 — Respect the abandoned cart toggle setting
                // Was sending recovery messages even when the feature was disabled in settings
                if (client.settings?.abandonedCartEnabled === false) {
                    log.debug(`[AbandonedCart] Skipping client ${client.clientId} — feature disabled`);
                    continue;
                }

                // Phase 9: Pre-fetch all HUMAN_TAKEOVER phones for this client — O(1) skip checks
                const skipSet = await buildSkipSet(client.clientId);

                // --- Step 0: Browse Abandonment (Customizable Delay) ---
                const browseDelayMin = parseInt(niche.browseDelay) || 30;
                const browseBatch = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    isOrderPlaced: { $ne: true },
                    addToCartCount: 0,
                    linkClicks: { $gt: 0 },
                    recoveryStep: { $exists: false },
                    updatedAt: { $lte: new Date(now - browseDelayMin * 60 * 1000), $gte: sevenDaysAgo }
                }).limit(20);

                for (const lead of browseBatch) {
                    if (skipSet.has(lead.phoneNumber)) continue;
                    const msg = `Hi ${lead.name || 'there'}! 👋 We noticed you checking out some amazing items. Need any help? We're here! 😊`;
                    await WhatsApp.sendText(client, lead.phoneNumber, msg);
                    await recordNudge(lead, msg);
                    await trackEcommerceEvent(client.clientId, { browseAbandonedCount: 1 });
                    await AdLead.findByIdAndUpdate(lead._id, { 
                        recoveryStep: 0, 
                        $push: { activityLog: { action: 'automation_nudge', details: 'browse_abandon', timestamp: new Date() } }
                    });
                }

                // --- Step 1: First Nudge (Dynamic Delay, Buttons, Image) ---
                const delay1Min = parseInt(niche.abandonedDelay1) || 15;
                const batch1 = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    isOrderPlaced: { $ne: true },
                    addToCartCount: { $gt: 0 },
                    recoveryStep: { $in: [null, 0] },
                    updatedAt: { $lte: new Date(now - delay1Min * 60 * 1000), $gte: sevenDaysAgo }
                }).limit(50);

                for (const lead of batch1) {
                    if (skipSet.has(lead.phoneNumber)) continue;
                    const msg = (niche.abandonedMsg15m || niche.abandonedMsg1)?.replace(/{name}/g, lead.name || 'there') || `Hi! 👋 We noticed you left something in your cart. Check it out now!`;
                    
                    await sendRichNudge(client, lead, msg, {
                        templateName: niche.abandonedTpl15m,
                        includeImage: niche.abandonedIncludeImage1 || !!niche.abandonedTpl15m,
                        buttons: [niche.abandonedMsg15m_btn1, niche.abandonedMsg15m_btn2]
                    });

                    await AdLead.findByIdAndUpdate(lead._id, { 
                        recoveryStep: 1, 
                        recoveryStartedAt: new Date(),
                        $push: { activityLog: { action: 'automation_nudge', details: 'cart_step_1', timestamp: new Date() } }
                    });
                    await trackEcommerceEvent(client.clientId, { abandonedCartSent: 1, cartRecoveryMessagesSent: 1 });
                }

                // --- Step 2: Second Nudge (Dynamic Delay, Image) ---
                const delay2Hr = parseInt(niche.abandonedDelay2) || 2;
                const batch2 = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    recoveryStep: 1,
                    recoveryStartedAt: { $lte: new Date(now - delay2Hr * 60 * 60 * 1000) },
                    isOrderPlaced: { $ne: true }
                }).limit(50);

                for (const lead of batch2) {
                    if (skipSet.has(lead.phoneNumber)) continue;
                    const msg = (niche.abandonedMsg2h || niche.abandonedMsg2)?.replace(/{name}/g, lead.name || 'there') || `Hey! Your items are still waiting for you. 😊`;
                    
                    await sendRichNudge(client, lead, msg, {
                        templateName: niche.abandonedTpl2h,
                        includeImage: niche.abandonedIncludeImage2 || !!niche.abandonedTpl2h,
                        buttons: [niche.abandonedMsg2h_btn1, niche.abandonedMsg2h_btn2]
                    });

                    await AdLead.findByIdAndUpdate(lead._id, { 
                        recoveryStep: 2, 
                        recoveryStartedAt: new Date(),
                        $push: { activityLog: { action: 'automation_nudge', details: 'cart_step_2', timestamp: new Date() } }
                    });
                    await trackEcommerceEvent(client.clientId, { cartRecoveryMessagesSent: 1 });
                }

                // --- Step 3: Final Nudge (Dynamic Delay, Image, Conditional Discount) ---
                const delay3Hr = parseInt(niche.abandonedDelay3) || 24;
                const batch3 = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    recoveryStep: 2,
                    recoveryStartedAt: { $lte: new Date(now - delay3Hr * 60 * 60 * 1000) },
                    isOrderPlaced: { $ne: true }
                }).limit(50);

                for (const lead of batch3) {
                    if (skipSet.has(lead.phoneNumber)) continue;
                    
                    // Phase 3: Conditional Discount Logic
                    const cartFlow = client.automationFlows?.find(f => f.id === 'abandoned_cart');
                    const flowConfig = cartFlow?.config || {};
                    
                    let discountCode = "";
                    let msg = (niche.abandonedMsg24h || niche.abandonedMsg3 || "Final call! Your cart is about to expire. 🛒").replace(/{name}/g, lead.name || 'there');
                    let templateName = niche.abandonedTpl24h || niche.abandonedTplFinal;

                    if (flowConfig.discountEnabled && client.storeType === 'shopify') {
                        try {
                            const { generatePriceRuleAndDiscount } = require('../utils/shopifyHelper');
                            const discount = await generatePriceRuleAndDiscount(client.clientId, flowConfig.discountPercent || 10);
                            discountCode = discount.code;
                            
                            // Prefer specialized discount template if provided
                            templateName = flowConfig.discountTemplate || templateName;
                            msg = `Hi ${lead.name || 'there'}! Use code *${discountCode}* to get ${flowConfig.discountPercent || 10}% OFF your cart! 🎁 Complete your order here: ${lead.checkoutUrl || ''}`;
                        } catch (err) {
                            log.error(`Discount generation failed for ${lead.phoneNumber}:`, err.message);
                        }
                    } else {
                        // Use "No Discount" template if configured
                        templateName = flowConfig.noDiscountTemplate || templateName;
                    }

                    await sendRichNudge(client, lead, msg, {
                        templateName: templateName,
                        includeImage: niche.abandonedIncludeImage3 || !!templateName,
                        buttons: [niche.abandonedMsg24h_btn1, niche.abandonedMsg24h_btn2]
                    });

                    await AdLead.findByIdAndUpdate(lead._id, { 
                        recoveryStep: 3,
                        activeDiscountCode: discountCode, // Store for AI to reference in Smart Recovery
                        $push: { activityLog: { action: 'automation_nudge', details: 'cart_step_3_discount', timestamp: new Date() } }
                    });
                    await trackEcommerceEvent(client.clientId, { cartRecoveryMessagesSent: 1 });
                }

                // --- Step 4: Post-Purchase Cross-sell (1 hour after order) ---
                const batch4 = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoNotOptedOut(),
                    isOrderPlaced: true,
                    recoveryStep: { $in: [1, 2, 3, null, 10] }, 
                    updatedAt: { $lte: new Date(now - 1 * 60 * 60 * 1000) }
                }).limit(20);

                for (const lead of batch4) {
                    if (wasRoleHandled(lead, 'upsell_1')) {
                        await AdLead.findByIdAndUpdate(lead._id, { recoveryStep: 11 }); 
                        continue;
                    }
                    if (!client.nicheData?.products?.length) continue;

                    const mainProducts = client.nicheData.products;
                    const randomItem = mainProducts[Math.floor(Math.random() * mainProducts.length)];
                    const upsellMsg = `Hope you're excited for your order, ${lead.name || 'friend'}! 🎉 Many customers who bought that also loved our *${randomItem.title || randomItem.name}*. Want to add it to your collection? See here: ${randomItem.url || ''}`;

                    await WhatsApp.sendText(client, lead.phoneNumber, upsellMsg);
                    await recordNudge(lead, upsellMsg);
                    await trackEcommerceEvent(client.clientId, { upsellSentCount: 1 });
                    await AdLead.findByIdAndUpdate(lead._id, { 
                        recoveryStep: 11,
                        $push: { activityLog: { action: 'automation_nudge', details: 'upsell_1', timestamp: new Date() } }
                    });
                }
            } // End for client
        } catch (e) {
            log.error('Abandoned Cart Cron Error:', e);
        }
    });

    // NOTE: Review dispatch is unified in cron/reviewCollection.js via reputationService.
    // Keeping a single scheduler avoids duplicate sends and status drift.
};

module.exports = scheduleAbandonedCartCron;
