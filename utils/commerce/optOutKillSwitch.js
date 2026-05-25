'use strict';

const AdLead = require('../../models/AdLead');
const SuppressionList = require('../../models/SuppressionList');
const { normalizePhoneWithCountry } = require('../core/helpers');
const {
  cancelAllAutomationsFor,
  phoneVariants,
  mapOptOutSourceToCancelReason,
} = require('../messaging/cancelAllAutomationsFor');
const log = require('../core/logger')('OptOutKillSwitch');

const STOP_CONFIRMATION =
  "You've been unsubscribed. You will no longer receive automated messages. Reply START anytime to re-subscribe.";

/**
 * Cancel all schedulable outbound work — delegates to cancelAllAutomationsFor (Slice 5).
 */
async function cancelPendingJobsForContact(clientId, phone, options = {}) {
  const reason =
    options.reason && String(options.reason).length
      ? mapOptOutSourceToCancelReason(options.reason)
      : mapOptOutSourceToCancelReason(options.source || 'keyword_stop');

  const out = await cancelAllAutomationsFor({
    clientId,
    phone,
    leadId: options.leadId || null,
    reason,
    channels: options.channels || 'all',
    actor: options.actor || { type: 'system', source: options.source || 'optOutKillSwitch' },
  });

  return {
    followUpSequences: out.cancelled.sequences,
    scheduledMessages: out.cancelled.scheduledMessages,
    campaignMessages: out.cancelled.campaignMessages,
    redisKeys: out.cancelled.redisKeys,
    bullmqJobs: out.cancelled.bullJobs,
    nlpJobs: out.cancelled.nlpJobs,
  };
}

/**
 * Atomic opt-out + job kill + optional immediate WhatsApp confirmation.
 */
async function executeGlobalOptOut({
  client,
  phone,
  email = null,
  source = 'keyword_stop',
  keyword = '',
  conversationId = null,
  sendConfirmation = true,
  io = null,
}) {
  if (!client?.clientId || !phone) {
    return { success: false, reason: 'missing_client_or_phone' };
  }

  const clientId = client.clientId;
  const now = new Date();
  const variants = phoneVariants(phone);

  const leadUpdate = {
    optStatus: 'opted_out',
    optOutDate: now,
    optOutSource: source,
    optOutReason: source,
    whatsappMarketingEligible: false,
  };
  if (keyword) leadUpdate.optOutKeyword = keyword;
  if (email) leadUpdate.email = String(email).toLowerCase();

  const lead = await AdLead.findOneAndUpdate(
    { clientId, phoneNumber: { $in: variants } },
    {
      $set: leadUpdate,
      $addToSet: { tags: 'Opted Out' },
      $push: {
        optInHistory: {
          $each: [
            {
              event: 'opted_out',
              action: 'opted_out',
              timestamp: now,
              source,
              note: keyword ? `User sent: "${keyword}"` : 'Global opt-out',
            },
          ],
          $position: 0,
          $slice: 40,
        },
      },
    },
    { upsert: false, new: true }
  );

  for (const v of variants) {
    await SuppressionList.findOneAndUpdate(
      { clientId, phone: v },
      { $set: { reason: 'opted_out', source, addedAt: now } },
      { upsert: true }
    );
  }

  if (conversationId) {
    const Conversation = require('../../models/Conversation');
    await Conversation.findByIdAndUpdate(conversationId, {
      $set: {
        botPaused: true,
        isBotPaused: true,
        botStatus: 'paused',
        status: 'OPTED_OUT',
      },
    });
  } else {
    const Conversation = require('../../models/Conversation');
    await Conversation.updateMany(
      { clientId, phone: { $in: variants } },
      {
        $set: {
          botPaused: true,
          isBotPaused: true,
          botStatus: 'paused',
          status: 'OPTED_OUT',
        },
      }
    );
  }

  const cancelSummary = await cancelPendingJobsForContact(clientId, phone, {
    source,
    leadId: lead?._id,
    actor: { type: 'system', source: `opt_out:${source}` },
  });

  if (io) {
    io.to(`client_${clientId}`).emit('lead_opted_out', { phone });
  }

  if (sendConfirmation) {
    try {
      const WhatsApp = require('../meta/whatsapp');
      await WhatsApp.sendText(client, phone, STOP_CONFIRMATION);
    } catch (e) {
      log.warn(`[OptOutKillSwitch] Confirmation send failed: ${e.message}`);
    }
  }

  return { success: true, cancelSummary, confirmation: STOP_CONFIRMATION };
}

async function executeGlobalOptOutForClient(client, phoneRaw, options = {}) {
  const phone = normalizePhoneWithCountry(phoneRaw, client);
  if (!phone) return { success: false, reason: 'invalid_phone' };
  return executeGlobalOptOut({
    client,
    phone,
    ...options,
  });
}

module.exports = {
  executeGlobalOptOut,
  executeGlobalOptOutForClient,
  cancelPendingJobsForContact,
  phoneVariants,
  STOP_CONFIRMATION,
};
