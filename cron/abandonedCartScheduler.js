const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const DailyStat = require('../models/DailyStat');
const Conversation = require('../models/Conversation');
const { trackEcommerceEvent } = require('../utils/core/analyticsHelper');
const log = require('../utils/core/logger')('AbandonedCart');
const { generateText } = require('../utils/core/gemini');
const WhatsApp = require('../utils/meta/whatsapp');
const { createMessage } = require('../utils/core/createMessage');
const cron = require('node-cron');
const axios = require('axios');
const {
  mongoCartRecoveryFilter,
  mongoNotOptedOut,
} = require('../utils/commerce/marketingConsent');
const { getAppRedis } = require('../utils/core/redisFactory');
const {
  cronEnvelopeSend,
  handleCronEnvelopeOutcome,
  hasRealPhone,
} = require('../utils/messaging/cronEnvelopeSend');
const { buildCartRecoveryComponents } = require('../utils/commerce/buildCartRecoveryComponents');
const { buildRecoveryUrl } = require('../utils/commerce/buildRecoveryUrl');

const CART_DEDUP_TTL_SEC = 48 * 3600;

async function wasCartRecoverySentRecently(clientId, phone, stepNum) {
  const redis = getAppRedis();
  if (!redis || redis.status !== 'ready') return false;
  const key = `cart_recovery:${clientId}:${phone}:step${stepNum}`;
  try {
    const hit = await redis.get(key);
    return !!hit;
  } catch {
    return false;
  }
}

async function markCartRecoverySent(clientId, phone, stepNum) {
  const redis = getAppRedis();
  if (!redis || redis.status !== 'ready') return;
  const key = `cart_recovery:${clientId}:${phone}:step${stepNum}`;
  try {
    await redis.set(key, '1', 'EX', CART_DEDUP_TTL_SEC);
  } catch (e) {
    log.warn(`[CartRecovery] dedup cache failed: ${e.message}`);
  }
}

function cartAbandonTimeFilter(now, delayMinutes, maxAgeHours = 168) {
  const abandonBefore = new Date(now.getTime() - delayMinutes * 60 * 1000);
  const abandonAfter = new Date(now.getTime() - maxAgeHours * 60 * 60 * 1000);
  return {
    $lte: abandonBefore,
    $gte: abandonAfter,
  };
}

const CART_NUDGE_DEFAULTS = {
  minutes1: 45,
  hours2: 8,
  hours3: 36,
};

/** Use merchant timing only when set; default strictly on null/undefined. */
function resolveCartNudgeDelay(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn(`[AbandonedCart] Invalid cart nudge delay "${value}" — using default ${fallback}`);
    return fallback;
  }
  return n;
}

function getCartRecoveryDelays(client) {
  const wf = client.wizardFeatures || {};
  return {
    delay1Min: resolveCartNudgeDelay(wf.cartNudgeMinutes1, CART_NUDGE_DEFAULTS.minutes1),
    delay2Hr: resolveCartNudgeDelay(wf.cartNudgeHours2, CART_NUDGE_DEFAULTS.hours2),
    delay3Hr: resolveCartNudgeDelay(wf.cartNudgeHours3, CART_NUDGE_DEFAULTS.hours3),
  };
}

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
        const { includeImage, buttons = [], templateName, stepNum = 1 } = options;
        const phone = lead.phoneNumber;
        const checkoutToken = lead.checkoutToken || lead.cartSnapshot?.checkoutToken || String(lead._id);
        const contactId = String(lead._id);
        const idempotencyKey = `cart:${checkoutToken}:step${stepNum}:${contactId}`;

        // 1. Prepare Data
        let imageUrl = null;
        if (includeImage && lead.cartSnapshot?.items?.[0]?.image) {
            imageUrl = lead.cartSnapshot.items[0].image;
        }

        const itemName = lead.cartSnapshot?.items?.[0]?.title || "items in your cart";
        const totalValue = lead.cartSnapshot?.totalPrice ? `₹${lead.cartSnapshot.totalPrice}` : "";
        const storeHost = client.shopDomain ? String(client.shopDomain).replace(/^https?:\/\//, '').split('/')[0] : '';
        const token = lead.checkoutToken || lead.cartSnapshot?.checkoutToken || '';
        const recoverFromToken =
          storeHost && token ? `https://${storeHost}/cart/recover/${token}` : '';
        const checkoutUrl =
          buildRecoveryUrl(
            lead.checkoutUrl ||
            lead.cartSnapshot?.checkoutUrl ||
            recoverFromToken ||
            '',
            stepNum
          );

        let successfullySent = false;

        // Email-only checkout (B9): no real phone but has email
        if (!hasRealPhone(phone) && lead.email) {
            const emailOut = await cronEnvelopeSend({
                client,
                clientId: client.clientId,
                channel: 'email',
                intent: 'marketing',
                email: lead.email,
                contactId,
                idempotencyKey,
                payload: {
                    subject: 'Complete your order',
                    html: text,
                },
                context: { source: 'cron/abandonedCartScheduler', step: stepNum },
            });
            if (!emailOut.useLegacy && emailOut.action === 'sent') {
                await recordNudge(lead, `[Email: abandoned cart recovery]`, 'email');
                successfullySent = true;
            }
        }

        // 2. If Meta Template is configured, use envelope or sendForAutomation
        if (!successfullySent && templateName) {
            log.info(`[Nudge] Sending template ${templateName} to ${phone || lead.email}`);
            const { components } = buildCartRecoveryComponents(lead, client, stepNum, {
              includeHeaderImage: stepNum !== 2,
              discountCode: lead.lastDiscountCode || lead.discountCode,
            });
            const templateOut = await cronEnvelopeSend({
                client,
                clientId: client.clientId,
                channel: 'whatsapp',
                intent: 'marketing',
                phone: hasRealPhone(phone) ? phone : null,
                contactId,
                idempotencyKey,
                payload: {
                    templateName,
                    templateLanguage: 'en',
                    components,
                },
                context: { source: 'cron/abandonedCartScheduler', step: stepNum },
            });
            if (!templateOut.useLegacy) {
                const outcome = handleCronEnvelopeOutcome(templateOut);
                if (outcome === 'sent' || outcome === 'duplicate') {
                    await recordNudge(lead, `[Template: ${templateName}]`, 'template');
                    successfullySent = outcome === 'sent';
                }
            }
        }
        if (!successfullySent && hasRealPhone(phone)) {
            const activeButtons = buttons.filter(b => b && b.trim()).slice(0, 3).map((b, i) => ({
                type: 'reply',
                reply: { id: `cart_btn_${i}_${lead._id}`, title: b.substring(0, 20) }
            }));

            let payload;
            if (activeButtons.length > 0) {
                payload = {
                    interactive: {
                        type: 'button',
                        header: imageUrl ? { type: 'image', image: { link: imageUrl } } : undefined,
                        body: { text },
                        action: { buttons: activeButtons },
                    },
                    text,
                };
            } else if (imageUrl) {
                payload = { media: { type: 'image', url: imageUrl }, text };
            } else {
                payload = { text };
            }
            const freeOut = await cronEnvelopeSend({
                client,
                clientId: client.clientId,
                intent: 'marketing',
                phone,
                contactId,
                idempotencyKey,
                payload,
                context: { source: 'cron/abandonedCartScheduler', step: stepNum },
            });
            if (!freeOut.useLegacy && (freeOut.action === 'sent' || freeOut.action === 'duplicate')) {
                await recordNudge(lead, text, activeButtons.length ? 'interactive' : 'text');
                successfullySent = freeOut.action === 'sent';
            }
        }
        
        if (successfullySent && hasRealPhone(phone)) {
            try {
                const { recordWhatsappTemplateSent } = require('../utils/commerce/cartRecoveryAttemptService');
                await recordWhatsappTemplateSent({
                    clientId: client.clientId,
                    phone,
                    templateName: templateName || 'cart_recovery_message',
                    followupNumber: stepNum,
                });
            } catch (craErr) {
                log.warn(`[CartRecovery] Failed to record WA send for ${phone}: ${craErr.message}`);
            }
        }
    } catch (err) {
        const errorMsg = err.friendlyMessage || err.message;
        log.error(`Nudge failed for ${lead.phoneNumber}: ${errorMsg}`);
    }
}

async function runAbandonedCartTick() {
        log.info('🚀 Abandoned cart cron tick — processing dynamic recovery steps...');
        try {
            const now = new Date();
            const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

            // Fetch all active clients with automation enabled
            const clients = await Client.find({
                $or: [
                    { 'automationFlows.id': 'abandoned_cart', 'automationFlows.isActive': true },
                    { commerceAutomations: { $elemMatch: { 'meta.category': 'abandoned_cart', isActive: true } } },
                ],
            })
                .select('clientId nicheData wizardFeatures automationFlows shopDomain storeType commerceAutomations')
                .lean();

            for (const client of clients) {
                await new Promise((r) => setImmediate(r));
                const niche = client.nicheData || {};
                const { delay1Min, delay2Hr, delay3Hr } = getCartRecoveryDelays(client);
                const delay2Min = delay2Hr * 60;
                const delay3Min = delay3Hr * 60;

                const cartRules = (client.commerceAutomations || []).filter(
                    (a) => a.meta?.category === 'abandoned_cart'
                );
                const cartRuleActive = (slot) => {
                    const r = cartRules.find((x) => x.meta?.systemSlot === slot);
                    return r?.isActive === true && !!r?.templateName;
                };
                const tplForSlot = (slot, fallback) => {
                    const r = cartRules.find((x) => x.meta?.systemSlot === slot);
                    return (r?.isActive && r.templateName) ? r.templateName : fallback;
                };

                // ✅ Phase R3: GAP 2 — Respect the abandoned cart toggle setting
                // Was sending recovery messages even when the feature was disabled in settings
                const { isAbandonedCartEnabled } = require('../utils/core/featureFlags');
                if (!isAbandonedCartEnabled(client)) {
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
                    const { isLeadOptedOutForSend } = require('../utils/commerce/marketingConsent');
                    if (await isLeadOptedOutForSend(client.clientId, lead.phoneNumber)) continue;
                    const msg = `Hi ${lead.name || 'there'}! 👋 We noticed you checking out some amazing items. Need any help? We're here! 😊`;
                    const { cronEnvelopeSend } = require('../utils/messaging/cronEnvelopeSend');
                    const out = await cronEnvelopeSend({
                      client,
                      clientId: client.clientId,
                      intent: 'marketing',
                      phone: lead.phoneNumber,
                      contactId: lead._id,
                      idempotencyKey: `browse:${client.clientId}:${lead._id}:${Math.floor(Date.now() / 86400000)}`,
                      payload: { text: msg },
                      context: { source: 'cron/abandonedCartScheduler:browse' },
                    });
                    if (out.useLegacy || out.action !== 'sent') continue;
                    await recordNudge(lead, msg);
                    await trackEcommerceEvent(client.clientId, { browseAbandonedCount: 1 });
                    await AdLead.findByIdAndUpdate(lead._id, { 
                        recoveryStep: 0, 
                        $push: { activityLog: { action: 'automation_nudge', details: 'browse_abandon', timestamp: new Date() } }
                    });
                }

                // --- Step 1: First Nudge (cartAbandonedAt + phone required) ---
                if (!cartRuleActive('followup_1')) {
                    log.debug(`[AbandonedCart] ${client.clientId} followup_1 paused — skip step 1`);
                } else {
                const batch1 = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    isOrderPlaced: { $ne: true },
                    cartStatus: 'abandoned',
                    $or: [
                      { phoneNumber: { $exists: true, $not: /^unknown_/ } },
                      { email: { $exists: true, $nin: [null, ''] }, phoneNumber: /^unknown_/ },
                    ],
                    recoveryStep: { $in: [null, 0] },
                    $or: [
                      { cartAbandonedAt: cartAbandonTimeFilter(now, delay1Min) },
                      {
                        cartAbandonedAt: { $exists: false },
                        lastCartEventAt: cartAbandonTimeFilter(now, delay1Min),
                      },
                    ],
                }).limit(50);

                for (const lead of batch1) {
                    const dedupePhone = hasRealPhone(lead.phoneNumber) ? lead.phoneNumber : lead.email;
                    if (hasRealPhone(lead.phoneNumber) && skipSet.has(lead.phoneNumber)) continue;
                    if (!hasRealPhone(lead.phoneNumber) && !lead.email) continue;
                    if (await wasCartRecoverySentRecently(client.clientId, dedupePhone, 1)) continue;
                    const msg = (niche.abandonedMsg15m || niche.abandonedMsg1)?.replace(/{name}/g, lead.name || 'there') || `Hi! 👋 We noticed you left something in your cart. Check it out now!`;
                    
                    await sendRichNudge(client, lead, msg, {
                        stepNum: 1,
                        templateName: tplForSlot('followup_1', niche.abandonedTpl15m),
                        includeImage: niche.abandonedIncludeImage1 || !!niche.abandonedTpl15m,
                        buttons: [niche.abandonedMsg15m_btn1, niche.abandonedMsg15m_btn2]
                    });

                    await markCartRecoverySent(client.clientId, dedupePhone, 1);
                    await AdLead.findByIdAndUpdate(lead._id, { 
                        recoveryStep: 1, 
                        recoveryStartedAt: new Date(),
                        $push: { activityLog: { action: 'automation_nudge', details: 'cart_step_1', timestamp: new Date() } }
                    });
                    await trackEcommerceEvent(client.clientId, { abandonedCartSent: 1, cartRecoveryMessagesSent: 1 });
                }
                }

                // --- Step 2: Second Nudge (from cart abandon time, not chained) ---
                if (!cartRuleActive('followup_2')) {
                    log.debug(`[AbandonedCart] ${client.clientId} followup_2 paused — skip step 2`);
                } else {
                const batch2 = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    isOrderPlaced: { $ne: true },
                    cartStatus: 'abandoned',
                    recoveryStep: { $in: [null, 0, 1] },
                    $or: [
                      { cartAbandonedAt: cartAbandonTimeFilter(now, delay2Min) },
                      {
                        cartAbandonedAt: { $exists: false },
                        lastCartEventAt: cartAbandonTimeFilter(now, delay2Min),
                      },
                    ],
                }).limit(50);

                for (const lead of batch2) {
                    if (skipSet.has(lead.phoneNumber)) continue;
                    if (await wasCartRecoverySentRecently(client.clientId, lead.phoneNumber, 2)) continue;
                    const msg = (niche.abandonedMsg2h || niche.abandonedMsg2)?.replace(/{name}/g, lead.name || 'there') || `Hey! Your items are still waiting for you. 😊`;
                    
                    await sendRichNudge(client, lead, msg, {
                        stepNum: 2,
                        templateName: tplForSlot('followup_2', niche.abandonedTpl2h),
                        includeImage: niche.abandonedIncludeImage2 || !!niche.abandonedTpl2h,
                        buttons: [niche.abandonedMsg2h_btn1, niche.abandonedMsg2h_btn2]
                    });

                    await markCartRecoverySent(client.clientId, lead.phoneNumber, 2);
                    await AdLead.findByIdAndUpdate(lead._id, { 
                        recoveryStep: Math.max(lead.recoveryStep || 0, 2), 
                        recoveryStartedAt: lead.recoveryStartedAt || new Date(),
                        $push: { activityLog: { action: 'automation_nudge', details: 'cart_step_2', timestamp: new Date() } }
                    });
                    await trackEcommerceEvent(client.clientId, { cartRecoveryMessagesSent: 1 });
                }
                }

                // --- Step 3: Final Nudge (from cart abandon time) ---
                if (!cartRuleActive('followup_3')) {
                    log.debug(`[AbandonedCart] ${client.clientId} followup_3 paused — skip step 3`);
                } else {
                const batch3 = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    isOrderPlaced: { $ne: true },
                    cartStatus: 'abandoned',
                    recoveryStep: { $in: [null, 0, 1, 2] },
                    $or: [
                      { cartAbandonedAt: cartAbandonTimeFilter(now, delay3Min) },
                      {
                        cartAbandonedAt: { $exists: false },
                        lastCartEventAt: cartAbandonTimeFilter(now, delay3Min),
                      },
                    ],
                }).limit(50);

                for (const lead of batch3) {
                    if (skipSet.has(lead.phoneNumber)) continue;
                    if (await wasCartRecoverySentRecently(client.clientId, lead.phoneNumber, 3)) continue;
                    
                    // Phase 3: Conditional Discount Logic
                    const cartFlow = client.automationFlows?.find(f => f.id === 'abandoned_cart');
                    const flowConfig = cartFlow?.config || {};
                    
                    let discountCode = "";
                    let msg = (niche.abandonedMsg24h || niche.abandonedMsg3 || "Final call! Your cart is about to expire. 🛒").replace(/{name}/g, lead.name || 'there');
                    let templateName = tplForSlot('followup_3', niche.abandonedTpl24h || niche.abandonedTplFinal);

                    if (flowConfig.discountEnabled && client.storeType === 'shopify') {
                        try {
                            const { generatePriceRuleAndDiscount } = require('../utils/shopify/shopifyHelper');
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
                        stepNum: 3,
                        templateName: templateName,
                        includeImage: niche.abandonedIncludeImage3 || !!templateName,
                        buttons: [niche.abandonedMsg24h_btn1, niche.abandonedMsg24h_btn2]
                    });

                    await markCartRecoverySent(client.clientId, lead.phoneNumber, 3);
                    await AdLead.findByIdAndUpdate(lead._id, { 
                        recoveryStep: 3,
                        activeDiscountCode: discountCode, // Store for AI to reference in Smart Recovery
                        $push: { activityLog: { action: 'automation_nudge', details: 'cart_step_3_discount', timestamp: new Date() } }
                    });
                    await trackEcommerceEvent(client.clientId, { cartRecoveryMessagesSent: 1 });
                }
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
}

const scheduleAbandonedCartCron = () => {
    if (process.env.CRON_USE_COORDINATOR !== 'false') return;
    cron.schedule('*/5 * * * *', runAbandonedCartTick);
};

scheduleAbandonedCartCron.runTick = runAbandonedCartTick;
module.exports = scheduleAbandonedCartCron;
