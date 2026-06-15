const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const DailyStat = require('../models/DailyStat');
const Conversation = require('../models/Conversation');
const { trackEcommerceEvent } = require('../utils/core/analyticsHelper');
const log = require('../utils/core/logger')('AbandonedCart');
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
const { buildLeadRecoveryUrl } = require('../utils/commerce/buildRecoveryUrl');
const { getCartRecoveryDelays } = require('../utils/commerce/cartRecoveryConfigService');
const { evaluateSmartSendWindow } = require('../utils/commerce/smartSendWindow');
const { shouldSuppressCartSend } = require('../utils/commerce/cartRecoverySuppression');
const { selectFairClientBatch } = require('../utils/commerce/cartCronFairness');
const { pushCartRecoveryDlq } = require('../utils/commerce/cartRecoveryDlq');
const { hasPendingMarketingSequenceSend } = require('../utils/commerce/cartSequenceSendDedup');
const { pickAbTestTemplate, resolveAbTestTemplatesForSlot } = require('../utils/commerce/cartRecoveryAbTest');
const { ABANDONED_CART_TAG } = require('../constants/cartRecoveryTags');

const CART_DEDUP_TTL_SEC = 48 * 3600;

function cartLeadDedupeKey(lead) {
  if (hasRealPhone(lead?.phoneNumber)) return lead.phoneNumber;
  const email = String(lead?.email || '').trim().toLowerCase();
  return email || null;
}

/** Leads with a real phone OR email-only (unknown_ phone placeholder). */
function cartLeadContactFilter() {
  return {
    $or: [
      { phoneNumber: { $exists: true, $not: /^unknown_/ } },
      { email: { $exists: true, $nin: [null, ''] }, phoneNumber: /^unknown_/ },
    ],
  };
}

async function setCartRuleSendError(clientId, ruleId, errorCode) {
  if (!clientId || !ruleId) return;
  try {
    await Client.updateOne(
      { clientId, 'commerceAutomations.id': String(ruleId) },
      {
        $set: {
          'commerceAutomations.$.lastSendError': errorCode,
          'commerceAutomations.$.lastSendErrorAt': new Date(),
          'commerceAutomations.$.lastSendStatus': 'failed',
        },
      }
    );
  } catch (err) {
    log.warn(`[CartRecovery] setCartRuleSendError failed: ${err.message}`);
  }
}

async function resolveCartStepTemplate(client, cartRules, slot, config, lead) {
  const rule = cartRules.find((x) => x.meta?.systemSlot === slot) || null;
  const channels = Array.isArray(rule?.channels) ? rule.channels : ['whatsapp'];
  const wantsWhatsApp = channels.includes('whatsapp');
  const { primary, variantB } = resolveAbTestTemplatesForSlot(rule, null);

  if (rule?.isActive === true && wantsWhatsApp && !primary) {
    log.warn(
      `[CartRecovery] Cart rule active but no template configured — ${client.clientId} ${slot}`
    );
    await setCartRuleSendError(client.clientId, rule.id, 'NO_TEMPLATE_CONFIGURED');
    return { blocked: true, templateName: null, rule };
  }

  if (!primary) {
    return { blocked: false, templateName: null, rule };
  }

  const stepNum = slot === 'followup_1' ? 1 : slot === 'followup_2' ? 2 : 3;
  const templateName = pickAbTestTemplate({
    clientId: client.clientId,
    leadId: String(lead?._id || ''),
    stepNum,
    templateA: primary,
    templateB: variantB,
    abTestEnabled: config.abTestEnabled,
  }).templateName;

  return { blocked: false, templateName, rule };
}

function wasStepSentInActivityLog(lead, stepNum, maxAgeSec = CART_DEDUP_TTL_SEC) {
  if (!lead?.activityLog?.length) return false;
  const cutoff = Date.now() - maxAgeSec * 1000;
  const detail = `cart_step_${stepNum}`;
  return lead.activityLog.some(
    (l) =>
      l.action === 'automation_nudge' &&
      String(l.details || '') === detail &&
      new Date(l.timestamp).getTime() > cutoff
  );
}

async function wasCartRecoverySentRecently(clientId, phone, stepNum, lead = null) {
  const redis = getAppRedis();
  if (redis && redis.status === 'ready') {
    const key = `cart_recovery:${clientId}:${phone}:step${stepNum}`;
    try {
      const hit = await redis.get(key);
      if (hit) return true;
    } catch {
      /* fall through to Mongo dedup */
    }
  }
  return lead ? wasStepSentInActivityLog(lead, stepNum) : false;
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

function smartSendEligibleFilter(now) {
  return {
    $or: [
      { nextAllowedSendAt: { $exists: false } },
      { nextAllowedSendAt: null },
      { nextAllowedSendAt: { $lte: now } },
    ],
  };
}

async function gateCartSend(client, lead, config, now) {
  const suppress = await shouldSuppressCartSend(client, lead, config);
  if (suppress.suppress) {
    return { ok: false, reason: suppress.reason };
  }
  const smart = evaluateSmartSendWindow(now, config);
  if (!smart.allowed) {
    await AdLead.updateOne(
      { _id: lead._id },
      { $set: { nextAllowedSendAt: smart.nextAllowedSendAt } }
    );
    return { ok: false, reason: 'smart_send_deferred' };
  }
  if (lead.nextAllowedSendAt) {
    await AdLead.updateOne({ _id: lead._id }, { $set: { nextAllowedSendAt: null } });
  }
  return { ok: true };
}

const CART_BATCH_SORT = { exitIntentAt: -1, cartValue: -1, cartAbandonedAt: 1, lastCartEventAt: 1 };

// Helper to check if a specific node role was handled previously
const wasRoleHandled = (lead, role) =>
  (lead.activityLog || []).some(
    (l) => l.action === 'automation_nudge' && l.details === role
  );

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

/** Universal Rich Nudge Helper.
 *  WS-3 hardening: returns a structured outcome so the caller can decide
 *  whether to advance `recoveryStep` + Redis dedup.
 *  Returns one of:
 *    - { sent: true, channel: 'whatsapp'|'email'|'free-form' }
 *    - { sent: false, reason: 'rate_limit'|'consent'|'no_channel'|'failed', detail }
 *  The previous return-undefined behaviour caused the cron to advance steps
 *  on every call (even rate-limited or skipped sends), so chained step 2/3
 *  never retried on failure. */
async function sendRichNudge(client, lead, text, options = {}) {
    try {
        const { includeImage, buttons = [], templateName, stepNum = 1, cartRule = null } = options;
        const {
            buildCartEmailContext,
            resolveOrderEmailTemplate,
            normalizeRuleChannels,
        } = require('../utils/core/orderEmailMergeFields');
        const channels = normalizeRuleChannels(cartRule || { channels: ['whatsapp'] });
        const wantsWhatsApp = channels.includes('whatsapp');
        const wantsEmail = channels.includes('email');
        const phone = lead.phoneNumber;
        const checkoutToken = lead.checkoutToken || lead.cartSnapshot?.checkoutToken || String(lead._id);
        const contactId = String(lead._id);
        const idempotencyKey = `cart:${checkoutToken}:step${stepNum}:${contactId}`;

        // 1. Prepare checkout URL for email + tracked WA button
        const checkoutUrl = buildLeadRecoveryUrl(client, lead, stepNum);

        let successfullySent = false;
        let waSent = false;
        let emailSent = false;
        let lastSkipReason = 'no_channel';
        let lastSkipDetail = null;
        let templateOut = null;
        let outboundMessageId = null;

        // Email channel (runs alongside WhatsApp when both are configured)
        const emailEligible =
          wantsEmail &&
          lead.email &&
          !lead.emailBounced &&
          lead.emailUnsubscribed !== true &&
          lead.optStatus !== 'email_opted_out';

        if (emailEligible) {
            const emailTemplate = await resolveOrderEmailTemplate({
                rule:
                  cartRule ||
                  {
                    id: `sys_cart_followup_${stepNum}`,
                    emailConfig: { templateId: `cart_recovery_email_${stepNum}`, sendWhen: 'always' },
                  },
                clientId: client.clientId,
                context: buildCartEmailContext(lead, client, stepNum, checkoutUrl),
            });
            if (emailTemplate.ok) {
                const emailOut = await cronEnvelopeSend({
                    client,
                    clientId: client.clientId,
                    channel: 'email',
                    intent: 'marketing',
                    email: lead.email,
                    contactId,
                    idempotencyKey: `${idempotencyKey}:email`,
                    payload: {
                        subject: emailTemplate.subject,
                        html: emailTemplate.html,
                    },
                    context: { source: 'cron/abandonedCartScheduler', step: stepNum, channel: 'email' },
                });
                if (!emailOut.useLegacy && (emailOut.action === 'sent' || emailOut.action === 'duplicate')) {
                    await recordNudge(lead, `[Email: ${emailTemplate.subject}]`, 'email');
                    emailSent = true;
                    successfullySent = true;
                } else if (!waSent) {
                    lastSkipReason = emailOut.action || 'failed';
                    lastSkipDetail = emailOut.reason || emailOut.errorCode || null;
                }
            } else if (!waSent && wantsEmail) {
                lastSkipReason = emailTemplate.reason || 'missing_email_template';
            }
        }

        // WhatsApp template path
        if (wantsWhatsApp && !waSent && templateName) {
            log.info(`[Nudge] Sending template ${templateName} to ${phone || lead.email}`);
            let trackedRecoveryUrl = checkoutUrl;
            if (checkoutUrl && hasRealPhone(phone)) {
              try {
                const { createCheckoutLinkRecord } = require('../utils/commerce/commerceCheckoutService');
                const { findPendingAttemptForSend } = require('../utils/commerce/cartRecoveryAttemptService');
                const pendingAttempt = await findPendingAttemptForSend({
                  clientId: client.clientId,
                  phone,
                  leadId: lead._id,
                  checkoutToken,
                });
                const link = await createCheckoutLinkRecord({
                  clientId: client.clientId,
                  phone,
                  fullUrl: checkoutUrl,
                  totalValue: Number(lead.cartValue || lead.cartSnapshot?.total_price || 0) || 0,
                  currency: lead.cartSnapshot?.currency || 'INR',
                  source: 'cart_recovery',
                  followupNumber: stepNum,
                  cartRecoveryAttemptId: pendingAttempt?._id || null,
                });
                if (link?.shortUrl) trackedRecoveryUrl = link.shortUrl;
              } catch (linkErr) {
                log.warn(`[Nudge] Tracked recovery URL skipped: ${linkErr.message}`);
              }
            }
            const { components } = buildCartRecoveryComponents(lead, client, stepNum, {
              includeHeaderImage: includeImage !== false,
              discountCode: lead.lastDiscountCode || lead.discountCode,
              recoveryUrl: trackedRecoveryUrl,
            });
            templateOut = await cronEnvelopeSend({
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
                    waSent = outcome === 'sent';
                    successfullySent = true;
                    outboundMessageId = templateOut.messageId || null;
                } else if (!emailSent) {
                    lastSkipReason = templateOut.action || outcome || 'failed';
                    lastSkipDetail = templateOut.reason || templateOut.errorCode || null;
                }
            } else if (!emailSent) {
                lastSkipReason = 'envelope_unavailable';
            }
        }
        // Compliance: no legacy free-text WA fallback — template or email channel only (Phase 7).

        if (successfullySent && waSent && hasRealPhone(phone)) {
            try {
                const { recordWhatsappTemplateSent } = require('../utils/commerce/cartRecoveryAttemptService');
                await recordWhatsappTemplateSent({
                    clientId: client.clientId,
                    phone,
                    templateName: templateName || 'cart_recovery_message',
                    followupNumber: stepNum,
                    leadId: lead._id,
                    checkoutToken: lead.checkoutToken || lead.cartSnapshot?.checkoutToken,
                    messageId: outboundMessageId,
                });
            } catch (craErr) {
                log.warn(`[CartRecovery] Failed to record WA send for ${phone}: ${craErr.message}`);
            }
        }

        if (successfullySent) {
            try {
                const { logCartRecoveryTemplateSend } = require('../utils/commerce/cartRecoverySendLog');
                const result = {
                  sent: true,
                  channel: waSent && emailSent ? 'both' : waSent ? 'whatsapp' : 'email',
                  waSent,
                  emailSent,
                  messageId: outboundMessageId || templateOut?.messageId,
                };
                await logCartRecoveryTemplateSend({
                  client,
                  lead,
                  stepNum,
                  templateName,
                  cartRule,
                  outcome: result,
                });
                const { emitCartRecoverySent } = require('../utils/commerce/pixelSocketEmit');
                emitCartRecoverySent(client.clientId, {
                  leadId: String(lead._id),
                  step: stepNum,
                  templateName: templateName || '',
                  phone: lead.phoneNumber,
                });
            } catch (logErr) {
                log.warn(`[CartRecovery] post-send log failed: ${logErr.message}`);
            }
            return {
              sent: true,
              channel: waSent && emailSent ? 'both' : waSent ? 'whatsapp' : 'email',
              waSent,
              emailSent,
              messageId: outboundMessageId || templateOut?.messageId,
            };
        }
        if (!successfullySent && hasRealPhone(phone) && wantsWhatsApp) {
            try {
                const { recordCartRecoverySendFailure } = require('../utils/commerce/cartRecoveryAttemptService');
                await recordCartRecoverySendFailure({
                    clientId: client.clientId,
                    phone,
                    leadId: lead._id,
                    checkoutToken: lead.checkoutToken || lead.cartSnapshot?.checkoutToken,
                    stepNum,
                    reason: lastSkipReason,
                    detail: lastSkipDetail,
                });
                await pushCartRecoveryDlq({
                    clientId: client.clientId,
                    leadId: lead._id,
                    stepNum,
                    phone,
                    templateName: templateName || '',
                    reason: lastSkipReason,
                    detail: lastSkipDetail,
                });
            } catch (recErr) {
                log.warn(`[CartRecovery] Failed to record send failure: ${recErr.message}`);
            }
        }

        return { sent: false, reason: lastSkipReason, detail: lastSkipDetail };
    } catch (err) {
        const errorMsg = err.friendlyMessage || err.message;
        log.error(`Nudge failed for ${lead.phoneNumber}: ${errorMsg}`);
        return { sent: false, reason: 'exception', detail: errorMsg };
    }
}

async function runAbandonedCartTick() {
        const redis = getAppRedis();
        const lockKey = 'cron:abandoned-cart:global-lock';
        const heartbeatKey = 'cron:abandoned-cart:last-tick';
        const lockTtlSec = 270;

        if (redis && redis.status === 'ready') {
            const lock = await redis.set(lockKey, String(process.pid), 'NX', 'EX', lockTtlSec);
            if (!lock) {
                log.info('[AbandonedCart] Skipping tick — another instance holds lock');
                return;
            }
        }

        log.info('🚀 Abandoned cart cron tick — processing dynamic recovery steps...');
        try {
            const now = new Date();
            const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
            const maxClientsPerTick = Math.max(
              5,
              parseInt(process.env.CART_CRON_MAX_CLIENTS_PER_TICK || '40', 10) || 40
            );

            // Fetch active clients with fairness round-robin (B6.3)
            const clients = await selectFairClientBatch(maxClientsPerTick);

            const { listActiveCartClientIds } = require('../utils/commerce/cartCronFairness');
            const totalActive = (await listActiveCartClientIds()).length;
            if (totalActive > maxClientsPerTick) {
                log.warn(`[AbandonedCart] Processing ${clients.length}/${totalActive} tenants this tick — increase CART_CRON_MAX_CLIENTS_PER_TICK if needed`);
            }

            for (const client of clients) {
                await new Promise((r) => setImmediate(r));
                const niche = client.nicheData || {};
                const { promotionDelayMin, delay1Min, delay2Min, delay3Min, config } =
                  getCartRecoveryDelays(client);

                const cartRules = (client.commerceAutomations || []).filter(
                    (a) => a.meta?.category === 'abandoned_cart'
                );
                const cartRuleActive = (slot) => {
                    const r = cartRules.find((x) => x.meta?.systemSlot === slot);
                    if (r?.isActive !== true) return false;
                    const channels = Array.isArray(r.channels) ? r.channels : ['whatsapp'];
                    if (channels.includes('whatsapp') && r.templateName) return true;
                    if (channels.includes('email')) return true;
                    return false;
                };
                const cartRuleForSlot = (slot) => cartRules.find((x) => x.meta?.systemSlot === slot) || null;

                // ✅ Phase R3: GAP 2 — Respect the abandoned cart toggle setting
                // Was sending recovery messages even when the feature was disabled in settings
                const { isAbandonedCartEnabled } = require('../utils/core/featureFlags');
                if (!isAbandonedCartEnabled(client)) {
                    log.debug(`[AbandonedCart] Skipping client ${client.clientId} — feature disabled`);
                    continue;
                }

                // Promote live-capture leads (cartStatus=active) → abandoned once promotion delay elapsed
                const promoteCutoff = new Date(now.getTime() - promotionDelayMin * 60 * 1000);
                const promoteResult = await AdLead.updateMany(
                    {
                        clientId: client.clientId,
                        cartStatus: 'active',
                        contactCapturedAt: { $ne: null },
                        isOrderPlaced: { $ne: true },
                        $or: [
                          { nextPromotionAt: { $lte: now } },
                          {
                            nextPromotionAt: { $exists: false },
                            $or: [
                              { lastCartEventAt: { $lte: promoteCutoff } },
                              {
                                lastCartEventAt: { $exists: false },
                                cartAbandonedAt: { $lte: promoteCutoff },
                              },
                            ],
                          },
                        ],
                    },
                    { $set: { cartStatus: 'abandoned', cartAbandonedAt: now, nextPromotionAt: null }, $addToSet: { tags: ABANDONED_CART_TAG } }
                );
                if (promoteResult.modifiedCount > 0) {
                    try {
                        const { emitCartPromoted } = require('../utils/commerce/pixelSocketEmit');
                        emitCartPromoted(client.clientId, { count: promoteResult.modifiedCount });
                    } catch (_) {
                        /* non-fatal */
                    }
                }

                // Phase 9: Pre-fetch all HUMAN_TAKEOVER phones for this client — O(1) skip checks
                const skipSet = await buildSkipSet(client.clientId);

                // --- Step 0: Browse Abandonment — disabled free-text path (Phase 7 compliance) ---
                const browseEnabled = false;
                const browseDelayMin = parseInt(niche.browseDelay) || 30;
                const browseBatch = browseEnabled ? await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    isOrderPlaced: { $ne: true },
                    addToCartCount: 0,
                    linkClicks: { $gt: 0 },
                    recoveryStep: { $exists: false },
                    updatedAt: { $lte: new Date(now - browseDelayMin * 60 * 1000), $gte: sevenDaysAgo }
                }).limit(20) : [];

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
                /** WS-3 fix: two top-level `$or` keys silently collided —
                 *  the second overwrote the first, dropping the
                 *  phone/email contact filter. Merge under `$and`. */
                const batch1 = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    isOrderPlaced: { $ne: true },
                    cartStatus: 'abandoned',
                    recoveryStep: { $in: [null, 0] },
                    $and: [
                      smartSendEligibleFilter(now),
                      cartLeadContactFilter(),
                      {
                        $or: [
                          { cartAbandonedAt: cartAbandonTimeFilter(now, delay1Min) },
                          {
                            cartAbandonedAt: { $exists: false },
                            lastCartEventAt: cartAbandonTimeFilter(now, delay1Min),
                          },
                        ],
                      },
                    ],
                })
                  .sort(CART_BATCH_SORT)
                  .limit(50);

                for (const lead of batch1) {
                    const dedupeKey = cartLeadDedupeKey(lead);
                    if (hasRealPhone(lead.phoneNumber) && skipSet.has(lead.phoneNumber)) continue;
                    if (!dedupeKey) continue;
                    if (await hasPendingMarketingSequenceSend(client.clientId, lead._id)) continue;
                    if (await wasCartRecoverySentRecently(client.clientId, dedupeKey, 1, lead)) continue;
                    const gate = await gateCartSend(client, lead, config, now);
                    if (!gate.ok) {
                      log.debug(`[CartRecovery] step 1 gated ${client.clientId} — ${gate.reason}`);
                      continue;
                    }
                    const resolved = await resolveCartStepTemplate(client, cartRules, 'followup_1', config, lead);
                    if (resolved.blocked) continue;
                    const msg = (niche.abandonedMsg15m || niche.abandonedMsg1)?.replace(/{name}/g, lead.name || 'there') || `Hi! 👋 We noticed you left something in your cart. Check it out now!`;

                    /** WS-3 hardening: only advance `recoveryStep` when the send
                     *  actually succeeded. Failed/skipped/rate-limited sends stay
                     *  on step 0 so the next 5-min tick retries cleanly. */
                    const outcome = await sendRichNudge(client, lead, msg, {
                        stepNum: 1,
                        templateName: resolved.templateName,
                        cartRule: resolved.rule || cartRuleForSlot('followup_1'),
                        includeImage: niche.abandonedIncludeImage1 || !!niche.abandonedTpl15m,
                        buttons: [niche.abandonedMsg15m_btn1, niche.abandonedMsg15m_btn2]
                    });

                    if (!outcome?.sent) {
                        log.warn(`[CartRecovery] step 1 skipped for ${client.clientId}/${String(dedupeKey).slice(-4)} — ${outcome?.reason || 'unknown'} ${outcome?.detail || ''}`);
                        continue;
                    }

                    await markCartRecoverySent(client.clientId, dedupeKey, 1);
                    await AdLead.findByIdAndUpdate(lead._id, {
                        recoveryStep: 1,
                        recoveryStartedAt: new Date(),
                        $push: { activityLog: { action: 'automation_nudge', details: 'cart_step_1', timestamp: new Date() } }
                    });
                    await trackEcommerceEvent(client.clientId, { abandonedCartSent: 1, cartRecoveryMessagesSent: 1 });
                }
                }

                /** WS-3: step 2 must be CHAINED after step 1 — a merchant who
                 *  only enabled rule #2 should not start sending mid-ladder.
                 *  Require `recoveryStep === 1` so the cadence stays 1 → 2 → 3. */
                if (!cartRuleActive('followup_2')) {
                    log.debug(`[AbandonedCart] ${client.clientId} followup_2 paused — skip step 2`);
                } else {
                const batch2 = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    isOrderPlaced: { $ne: true },
                    cartStatus: 'abandoned',
                    recoveryStep: 1,
                    $and: [
                      smartSendEligibleFilter(now),
                      cartLeadContactFilter(),
                      {
                        $or: [
                          { cartAbandonedAt: cartAbandonTimeFilter(now, delay2Min) },
                          {
                            cartAbandonedAt: { $exists: false },
                            lastCartEventAt: cartAbandonTimeFilter(now, delay2Min),
                          },
                        ],
                      },
                    ],
                })
                  .sort(CART_BATCH_SORT)
                  .limit(50);

                for (const lead of batch2) {
                    const dedupeKey = cartLeadDedupeKey(lead);
                    if (hasRealPhone(lead.phoneNumber) && skipSet.has(lead.phoneNumber)) continue;
                    if (!dedupeKey) continue;
                    if (await hasPendingMarketingSequenceSend(client.clientId, lead._id)) continue;
                    if (await wasCartRecoverySentRecently(client.clientId, dedupeKey, 2, lead)) continue;
                    const gate2 = await gateCartSend(client, lead, config, now);
                    if (!gate2.ok) continue;
                    const resolved = await resolveCartStepTemplate(client, cartRules, 'followup_2', config, lead);
                    if (resolved.blocked) continue;
                    const msg = (niche.abandonedMsg2h || niche.abandonedMsg2)?.replace(/{name}/g, lead.name || 'there') || `Hey! Your items are still waiting for you. 😊`;

                    const outcome = await sendRichNudge(client, lead, msg, {
                        stepNum: 2,
                        templateName: resolved.templateName,
                        cartRule: resolved.rule || cartRuleForSlot('followup_2'),
                        includeImage: niche.abandonedIncludeImage2 || !!niche.abandonedTpl2h,
                        buttons: [niche.abandonedMsg2h_btn1, niche.abandonedMsg2h_btn2]
                    });

                    if (!outcome?.sent) {
                        log.warn(`[CartRecovery] step 2 skipped for ${client.clientId}/${String(dedupeKey).slice(-4)} — ${outcome?.reason || 'unknown'} ${outcome?.detail || ''}`);
                        continue;
                    }

                    await markCartRecoverySent(client.clientId, dedupeKey, 2);
                    await AdLead.findByIdAndUpdate(lead._id, {
                        recoveryStep: Math.max(lead.recoveryStep || 0, 2),
                        recoveryStartedAt: lead.recoveryStartedAt || new Date(),
                        $push: { activityLog: { action: 'automation_nudge', details: 'cart_step_2', timestamp: new Date() } }
                    });
                    await trackEcommerceEvent(client.clientId, { cartRecoveryMessagesSent: 1 });
                }
                }

                /** WS-3: step 3 must be CHAINED after step 2 (recoveryStep === 2). */
                if (!cartRuleActive('followup_3')) {
                    log.debug(`[AbandonedCart] ${client.clientId} followup_3 paused — skip step 3`);
                } else {
                const batch3 = await AdLead.find({
                    clientId: client.clientId,
                    ...mongoCartRecoveryFilter(client),
                    isOrderPlaced: { $ne: true },
                    cartStatus: 'abandoned',
                    recoveryStep: 2,
                    $and: [
                      smartSendEligibleFilter(now),
                      cartLeadContactFilter(),
                      {
                        $or: [
                          { cartAbandonedAt: cartAbandonTimeFilter(now, delay3Min) },
                          {
                            cartAbandonedAt: { $exists: false },
                            lastCartEventAt: cartAbandonTimeFilter(now, delay3Min),
                          },
                        ],
                      },
                    ],
                })
                  .sort(CART_BATCH_SORT)
                  .limit(50);

                for (const lead of batch3) {
                    const dedupeKey = cartLeadDedupeKey(lead);
                    if (hasRealPhone(lead.phoneNumber) && skipSet.has(lead.phoneNumber)) continue;
                    if (!dedupeKey) continue;
                    if (await hasPendingMarketingSequenceSend(client.clientId, lead._id)) continue;
                    if (await wasCartRecoverySentRecently(client.clientId, dedupeKey, 3, lead)) continue;
                    const gate3 = await gateCartSend(client, lead, config, now);
                    if (!gate3.ok) continue;
                    const resolved = await resolveCartStepTemplate(client, cartRules, 'followup_3', config, lead);
                    if (resolved.blocked) continue;
                    
                    // Phase 4: dynamic discount via cartRecoveryConfig
                    const { resolveCartStepDiscount } = require('../utils/commerce/cartDiscountService');
                    const discountOut = await resolveCartStepDiscount(client, lead, 3);
                    let discountCode = discountOut.discountCode || '';
                    let msg = (niche.abandonedMsg24h || niche.abandonedMsg3 || "Final call! Your cart is about to expire. 🛒").replace(/{name}/g, lead.name || 'there');
                    let templateName = resolved.templateName;
                    if (discountCode) {
                      lead.lastDiscountCode = discountCode;
                      lead.discountCode = discountCode;
                      msg = `Hi ${lead.name || 'there'}! Use code *${discountCode}* to complete your order. 🎁`;
                    }

                    const outcome3 = await sendRichNudge(client, lead, msg, {
                        stepNum: 3,
                        templateName: templateName,
                        cartRule: resolved.rule || cartRuleForSlot('followup_3'),
                        includeImage: niche.abandonedIncludeImage3 || !!templateName,
                        buttons: [niche.abandonedMsg24h_btn1, niche.abandonedMsg24h_btn2]
                    });

                    if (!outcome3?.sent) {
                        log.warn(`[CartRecovery] step 3 skipped for ${client.clientId}/${String(dedupeKey).slice(-4)} — ${outcome3?.reason || 'unknown'} ${outcome3?.detail || ''}`);
                        continue;
                    }

                    await markCartRecoverySent(client.clientId, dedupeKey, 3);
                    await AdLead.findByIdAndUpdate(lead._id, {
                        recoveryStep: 3,
                        activeDiscountCode: discountCode,
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

                    const upsellOut = await cronEnvelopeSend({
                      client,
                      clientId: client.clientId,
                      intent: 'marketing',
                      phone: lead.phoneNumber,
                      contactId: lead._id,
                      idempotencyKey: `upsell:${client.clientId}:${lead._id}`,
                      payload: { text: upsellMsg },
                      context: { source: 'cron/abandonedCartScheduler:upsell' },
                    });
                    if (upsellOut.useLegacy || (upsellOut.action !== 'sent' && upsellOut.action !== 'duplicate')) continue;

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
        } finally {
            if (redis && redis.status === 'ready') {
                await redis.set(heartbeatKey, String(Date.now()), 'EX', 86400).catch(() => null);
                await redis.del(lockKey).catch(() => null);
            }
        }
}

const scheduleAbandonedCartCron = () => {
    if (process.env.CRON_USE_COORDINATOR !== 'false') return;
    cron.schedule('*/5 * * * *', runAbandonedCartTick);
};

scheduleAbandonedCartCron.runTick = runAbandonedCartTick;
scheduleAbandonedCartCron.sendRichNudge = sendRichNudge;
module.exports = scheduleAbandonedCartCron;
