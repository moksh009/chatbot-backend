'use strict';

const AdLead = require('../../models/AdLead');
const SuppressionList = require('../../models/SuppressionList');
const { phoneVariants } = require('./optOutKillSwitch');
const {
  normalizeOptStatus,
  buildKeywordOptInSetFields,
} = require('./marketingOptStatusRules');
const log = require('../core/logger')('InboundReOptIn');

function isLeadOptedOut(lead) {
  if (!lead) return false;
  const waStatus = normalizeOptStatus(lead?.channelConsent?.whatsapp?.status);
  const globalStatus = normalizeOptStatus(lead?.optStatus);
  return waStatus === 'opted_out' || globalStatus === 'opted_out';
}

async function findLeadByPhone(clientId, phone) {
  if (!clientId || !phone) return null;
  const variants = phoneVariants(phone);
  return AdLead.findOne({ clientId, phoneNumber: { $in: variants } }).lean();
}

function buildInboundReOptInHistoryEntry(source = 'inbound_message') {
  return {
    event: 'opted_in',
    action: 're_opted_in',
    timestamp: new Date(),
    source,
    note: 'User re-engaged after opt-out',
  };
}

function applyLeadOptInToMemory(lead) {
  if (!lead) return lead;
  const now = new Date();
  lead.optStatus = 'opted_in';
  lead.whatsappMarketingEligible = true;
  lead.optOutDate = null;
  lead.optOutSource = '';
  if (!lead.channelConsent) lead.channelConsent = {};
  if (!lead.channelConsent.whatsapp) lead.channelConsent.whatsapp = {};
  lead.channelConsent.whatsapp.status = 'opted_in';
  lead.channelConsent.whatsapp.source = 'inbound_message';
  lead.channelConsent.whatsapp.lastUpdated = now;
  lead.channelConsent.whatsapp.timestamp = now;
  lead.channelConsent.whatsapp.unsubscribeAt = null;
  return lead;
}

function applyConvoResumeToMemory(convo) {
  if (!convo) return convo;
  convo.botPaused = false;
  convo.isBotPaused = false;
  convo.botStatus = 'active';
  convo.status = 'BOT_ACTIVE';
  convo.requiresAttention = false;
  return convo;
}

/**
 * Silent or explicit re-opt-in when a user messages after STOP.
 * Restores lead consent, clears suppression, resumes conversation.
 */
async function executeInboundReOptIn({
  client,
  phone,
  lead = null,
  convo = null,
  source = 'inbound_message',
  io = null,
  silent = true,
}) {
  if (!client?.clientId || !phone) {
    return { success: false, reason: 'missing_client_or_phone' };
  }

  const clientId = client.clientId;
  const variants = phoneVariants(phone);
  const leadDoc = lead || (await findLeadByPhone(clientId, phone));

  if (!leadDoc?._id) {
    log.warn(`[InboundReOptIn] No lead found for ${clientId}:${phone}`);
    return { success: false, reason: 'lead_not_found' };
  }

  if (!isLeadOptedOut(leadDoc)) {
    return { success: true, skipped: true, lead: leadDoc, convo };
  }

  const setFields = {
    ...buildKeywordOptInSetFields(),
    optOutReason: '',
    optOutKeyword: '',
    'channelConsent.whatsapp.unsubscribeAt': null,
  };

  const updatedLead = await AdLead.findOneAndUpdate(
    { _id: leadDoc._id, clientId },
    {
      $set: setFields,
      $push: {
        optInHistory: buildInboundReOptInHistoryEntry(source),
      },
    },
    { new: true, lean: true }
  );

  if (!updatedLead) {
    return { success: false, reason: 'lead_update_failed' };
  }

  await SuppressionList.deleteMany({
    clientId,
    phone: { $in: variants },
  });

  const Conversation = require('../../models/Conversation');
  const convoPatch = {
    botPaused: false,
    isBotPaused: false,
    botStatus: 'active',
    status: 'BOT_ACTIVE',
    requiresAttention: false,
  };

  let updatedConvo = convo;
  if (convo?._id) {
    updatedConvo = await Conversation.findByIdAndUpdate(
      convo._id,
      { $set: convoPatch },
      { new: true, lean: true }
    );
  } else {
    await Conversation.updateMany({ clientId, phone: { $in: variants } }, { $set: convoPatch });
    updatedConvo = await Conversation.findOne({ clientId, phone: { $in: variants } }).lean();
  }

  try {
    const { transitionLeadTags } = require('./leadTagOps');
    await transitionLeadTags({
      filter: { _id: updatedLead._id, clientId },
      add: ['Opted In'],
      remove: ['Opted Out'],
    });
  } catch (_) {
    /* non-fatal */
  }

  if (io) {
    try {
      const { broadcastConversationPatches } = require('./optOutKillSwitch');
      await broadcastConversationPatches({
        clientId,
        phone,
        patch: convoPatch,
        io,
      });
      io.to(`client_${clientId}`).emit('lead_opted_in', {
        phone,
        optStatus: 'opted_in',
        silent,
      });
    } catch (_) {
      /* non-fatal */
    }
  }

  applyLeadOptInToMemory(updatedLead);
  if (updatedConvo) applyConvoResumeToMemory(updatedConvo);

  log.info(`[InboundReOptIn] Re-opted-in ${clientId}:${phone} (silent=${silent})`);

  return {
    success: true,
    skipped: false,
    lead: updatedLead,
    convo: updatedConvo,
  };
}

function isUserInitiatedInbound(parsedMessage) {
  if (!parsedMessage) return false;
  const type = String(parsedMessage.type || '').toLowerCase();
  if (type === 'text' && String(parsedMessage.text?.body || '').trim()) return true;
  if (type === 'interactive') {
    const it = parsedMessage.interactive || {};
    if (it.button_reply || it.list_reply || it.nfm_reply) return true;
  }
  if (['image', 'video', 'audio', 'document', 'sticker'].includes(type)) return true;
  if (parsedMessage.button?.text) return true;
  return false;
}

module.exports = {
  isLeadOptedOut,
  findLeadByPhone,
  executeInboundReOptIn,
  isUserInitiatedInbound,
  applyLeadOptInToMemory,
  applyConvoResumeToMemory,
};
