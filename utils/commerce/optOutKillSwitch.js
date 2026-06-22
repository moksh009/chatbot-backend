'use strict';

const AdLead = require('../../models/AdLead');
const SuppressionList = require('../../models/SuppressionList');
const { normalizePhoneWithCountry } = require('../core/helpers');
const {
  cancelAllAutomationsFor,
  phoneVariants,
  mapOptOutSourceToCancelReason,
} = require('../messaging/cancelAllAutomationsFor');
const { getOptOutAutoReply, DEFAULT_OPT_OUT_AUTO_REPLY } = require('./marketingConsentConfig');
const log = require('../core/logger')('OptOutKillSwitch');

const STOP_CONFIRMATION = DEFAULT_OPT_OUT_AUTO_REPLY;

async function broadcastConversationPatches({ clientId, phone, patch, io }) {
  if (!io || !clientId || !phone) return;
  const Conversation = require('../../models/Conversation');
  const variants = phoneVariants(phone);
  const convos = await Conversation.find({ clientId, phone: { $in: variants } })
    .populate('assignedTo', 'name')
    .lean();
  for (const c of convos) {
    io.to(`client_${clientId}`).emit('conversation_update', { ...c, ...patch });
  }
}

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
  confirmationMessage = null,
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
    'channelConsent.whatsapp.status': 'opted_out',
    'channelConsent.whatsapp.source': source === 'keyword_stop' ? 'stop_keyword' : source,
    'channelConsent.whatsapp.timestamp': now,
    'channelConsent.whatsapp.lastUpdated': now,
    'channelConsent.whatsapp.unsubscribeAt': now,
  };
  if (keyword) leadUpdate.optOutKeyword = keyword;
  if (email) leadUpdate.email = String(email).toLowerCase();

  const lead = await AdLead.findOneAndUpdate(
    { clientId, phoneNumber: { $in: variants } },
    {
      $set: leadUpdate,
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

  if (lead?._id) {
    const { transitionLeadTags } = require('./leadTagOps');
    await transitionLeadTags({
      filter: { _id: lead._id, clientId },
      add: ['Opted Out'],
      remove: ['Opted In'],
    });
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
    await broadcastConversationPatches({
      clientId,
      phone,
      patch: {
        botPaused: true,
        isBotPaused: true,
        botStatus: 'paused',
        status: 'OPTED_OUT',
      },
      io,
    });
    io.to(`client_${clientId}`).emit('lead_opted_out', { phone, optStatus: 'opted_out' });
  }

  if (sendConfirmation) {
    try {
      const { sendComplianceText } = require('../messaging/sendComplianceText');
      const confirmationText =
        confirmationMessage && String(confirmationMessage).trim()
          ? String(confirmationMessage).trim()
          : getOptOutAutoReply(client);
      await sendComplianceText(client, phone, confirmationText, {
        source: 'optOutKillSwitch:confirmation',
        conversationId,
      });
    } catch (e) {
      log.warn(`[OptOutKillSwitch] Confirmation send failed: ${e.message}`);
    }
  }

  for (const v of variants) {
    await SuppressionList.findOneAndUpdate(
      { clientId, phone: v },
      { $set: { reason: 'opted_out', source, addedAt: now } },
      { upsert: true }
    );
  }

  const confirmationUsed =
    confirmationMessage && String(confirmationMessage).trim()
      ? String(confirmationMessage).trim()
      : getOptOutAutoReply(client);

  return { success: true, cancelSummary, confirmation: confirmationUsed };
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
  broadcastConversationPatches,
  phoneVariants,
  STOP_CONFIRMATION,
};
