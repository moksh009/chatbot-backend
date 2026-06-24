'use strict';

/**
 * Platform-wide WhatsApp marketing consent orchestration.
 * Policy: implicit opt-in on first message; STOP opts out; any inbound re-subscribes silently.
 */

const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const SuppressionList = require('../../models/SuppressionList');
const { phoneVariants } = require('./optOutKillSwitch');
const {
  isLeadOptedOut,
  findLeadByPhone,
  executeInboundReOptIn,
} = require('./inboundReOptInService');
const {
  buildDefaultOptInSetFields,
  normalizeOptStatus,
} = require('./marketingOptStatusRules');
const log = require('../core/logger')('MarketingConsentPlatform');

const RECENT_INBOUND_MS = 24 * 60 * 60 * 1000;

function isMarketingAutomationContext({ contextType, slotId, trigger } = {}) {
  const ctx = String(contextType || '').toLowerCase();
  if (ctx === 'abandoned_cart' || ctx === 'marketing' || ctx === 'campaign') return true;
  const slot = String(slotId || '').toLowerCase();
  if (slot.startsWith('cart_recovery')) return true;
  const tr = String(trigger || '').toLowerCase();
  return tr.includes('cart_recovery') || tr.includes('marketing');
}

/**
 * First WhatsApp contact — implicit marketing opt-in (India D2C default).
 * Skips if already opted_out (STOP must win).
 */
async function ensureImplicitWhatsAppOptIn({ clientId, lead, phone }) {
  if (!clientId || !lead?._id) return { updated: false, lead };

  if (isLeadOptedOut(lead)) {
    return { updated: false, lead, skipped: 'opted_out' };
  }

  const waStatus = normalizeOptStatus(lead?.channelConsent?.whatsapp?.status);
  const globalStatus = normalizeOptStatus(lead?.optStatus);
  const needsChannel =
    waStatus === 'unknown' ||
    !lead?.channelConsent?.whatsapp?.status ||
    globalStatus === 'unknown';

  if (!needsChannel && globalStatus === 'opted_in') {
    return { updated: false, lead };
  }

  const setFields = buildDefaultOptInSetFields('inbound_message');
  const updated = await AdLead.findOneAndUpdate(
    { _id: lead._id, clientId, optStatus: { $ne: 'opted_out' } },
    {
      $set: setFields,
      $push: {
        optInHistory: {
          event: 'opted_in',
          action: 'opted_in',
          source: 'first_whatsapp_message',
          timestamp: new Date(),
          note: 'Implicit opt-in on first WhatsApp message',
        },
      },
    },
    { new: true, lean: true }
  );

  return { updated: !!updated, lead: updated || lead };
}

async function auditConsentHealth(clientId) {
  if (!clientId) {
    return {
      synced: 0,
      leadOptedOutConvoActive: 0,
      convoOptedOutLeadActive: 0,
      suppressionWithoutOptOut: 0,
      optOutWithoutSuppression: 0,
      totalDrift: 0,
    };
  }

  const optedOutLeads = await AdLead.find({ clientId, optStatus: 'opted_out' })
    .select('phoneNumber channelConsent.whatsapp.status')
    .lean();

  const optedOutPhones = new Set();
  for (const l of optedOutLeads) {
    for (const v of phoneVariants(l.phoneNumber)) optedOutPhones.add(v);
  }

  let leadOptedOutConvoActive = 0;
  if (optedOutPhones.size) {
    leadOptedOutConvoActive = await Conversation.countDocuments({
      clientId,
      phone: { $in: [...optedOutPhones] },
      status: { $nin: ['OPTED_OUT', 'HUMAN_SUPPORT', 'HUMAN_TAKEOVER'] },
      botPaused: { $ne: true },
    });
  }

  const convoOptedOut = await Conversation.find({ clientId, status: 'OPTED_OUT' })
    .select('phone')
    .lean();
  let convoOptedOutLeadActive = 0;
  for (const c of convoOptedOut) {
    const lead = await findLeadByPhone(clientId, c.phone);
    if (lead && !isLeadOptedOut(lead)) convoOptedOutLeadActive += 1;
  }

  const suppressions = await SuppressionList.find({ clientId, channel: { $in: ['whatsapp', 'all'] } })
    .select('phone')
    .lean();
  let suppressionWithoutOptOut = 0;
  for (const s of suppressions) {
    const lead = await findLeadByPhone(clientId, s.phone);
    if (!lead || !isLeadOptedOut(lead)) suppressionWithoutOptOut += 1;
  }

  let optOutWithoutSuppression = 0;
  for (const l of optedOutLeads) {
    const variants = phoneVariants(l.phoneNumber);
    const found = await SuppressionList.findOne({
      clientId,
      phone: { $in: variants },
    }).lean();
    if (!found) optOutWithoutSuppression += 1;
  }

  const totalDrift =
    leadOptedOutConvoActive +
    convoOptedOutLeadActive +
    suppressionWithoutOptOut +
    optOutWithoutSuppression;

  const totalLeads = await AdLead.countDocuments({ clientId });
  const synced = Math.max(0, totalLeads - totalDrift);

  return {
    synced,
    leadOptedOutConvoActive,
    convoOptedOutLeadActive,
    suppressionWithoutOptOut,
    optOutWithoutSuppression,
    totalDrift,
    totalLeads,
    policy: {
      reOptIn: 'silent_on_any_inbound',
      newContact: 'implicit_opt_in',
      stopKeywords: ['STOP', 'UNSUBSCRIBE'],
    },
  };
}

/**
 * Align lead, conversation, and suppression for one tenant.
 */
async function syncConsentStateForClient(clientId, options = {}) {
  const dryRun = options.dryRun === true;
  const recentMs = Number(options.recentInboundMs) || RECENT_INBOUND_MS;
  const stats = {
    clientId,
    dryRun,
    leadsReOptedIn: 0,
    convosPaused: 0,
    convosResumed: 0,
    suppressionsAdded: 0,
    suppressionsRemoved: 0,
    errors: 0,
  };

  const optedOutLeads = await AdLead.find({ clientId, optStatus: 'opted_out' }).lean();
  for (const lead of optedOutLeads) {
    const variants = phoneVariants(lead.phoneNumber);
    try {
      const convos = await Conversation.find({ clientId, phone: { $in: variants } }).lean();
      for (const c of convos) {
        const recent =
          c.lastInteraction &&
          Date.now() - new Date(c.lastInteraction).getTime() < recentMs;
        if (recent && !dryRun) {
          const client = { clientId };
          await executeInboundReOptIn({
            client,
            phone: c.phone,
            lead,
            convo: c,
            source: 'consent_sync',
            silent: true,
          });
          stats.leadsReOptedIn += 1;
        } else if (c.status !== 'OPTED_OUT' || !c.botPaused) {
          if (!dryRun) {
            await Conversation.updateOne(
              { _id: c._id },
              {
                $set: {
                  status: 'OPTED_OUT',
                  botPaused: true,
                  isBotPaused: true,
                  botStatus: 'paused',
                },
              }
            );
          }
          stats.convosPaused += 1;
        }
      }

      for (const v of variants) {
        const exists = await SuppressionList.findOne({ clientId, phone: v }).lean();
        if (!exists) {
          if (!dryRun) {
            await SuppressionList.findOneAndUpdate(
              { clientId, phone: v },
              { $set: { reason: 'opted_out', source: 'consent_sync', addedAt: new Date() } },
              { upsert: true }
            );
          }
          stats.suppressionsAdded += 1;
        }
      }

      if (!lead.channelConsent?.whatsapp?.status || lead.channelConsent.whatsapp.status !== 'opted_out') {
        if (!dryRun) {
          await AdLead.updateOne(
            { _id: lead._id },
            {
              $set: {
                'channelConsent.whatsapp.status': 'opted_out',
                'channelConsent.whatsapp.lastUpdated': new Date(),
              },
            }
          );
        }
      }
    } catch (e) {
      stats.errors += 1;
      log.warn(`[ConsentSync] lead ${lead._id}: ${e.message}`);
    }
  }

  const optedInLeads = await AdLead.find({
    clientId,
    optStatus: { $in: ['opted_in', 'unknown', 'pending'] },
  })
    .select('phoneNumber')
    .lean();

  for (const lead of optedInLeads) {
    const variants = phoneVariants(lead.phoneNumber);
    try {
      if (!dryRun) {
        await SuppressionList.deleteMany({ clientId, phone: { $in: variants } });
      }
      const removed = await SuppressionList.countDocuments({ clientId, phone: { $in: variants } });
      if (removed) stats.suppressionsRemoved += removed;

      const pausedConvos = await Conversation.find({
        clientId,
        phone: { $in: variants },
        status: 'OPTED_OUT',
      }).lean();
      for (const c of pausedConvos) {
        if (!dryRun) {
          await Conversation.updateOne(
            { _id: c._id },
            {
              $set: {
                status: 'BOT_ACTIVE',
                botPaused: false,
                isBotPaused: false,
                botStatus: 'active',
              },
            }
          );
        }
        stats.convosResumed += 1;
      }
    } catch (e) {
      stats.errors += 1;
    }
  }

  stats.health = await auditConsentHealth(clientId);
  return stats;
}

module.exports = {
  ensureImplicitWhatsAppOptIn,
  auditConsentHealth,
  syncConsentStateForClient,
  isMarketingAutomationContext,
  RECENT_INBOUND_MS,
};
