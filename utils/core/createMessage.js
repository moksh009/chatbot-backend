"use strict";

const Message = require("../../models/Message");

const Conversation = require("../../models/Conversation");

/**
 * Normalizes and saves a message to the database.
 * Ensures field names (body vs content, from vs phone) are handled correctly.
 */
async function createMessage(data) {
  // 1. Normalize Direction
  const normalizeDirection = (dir, type) => {
    if (["inbound", "in", "received", "incoming"].includes(dir?.toLowerCase())) {
        return "incoming";
    }
    if (["outbound", "out", "sent", "outgoing"].includes(dir?.toLowerCase())) {
        return "outgoing";
    }
    return "incoming"; // Default fallback
  };

  // 2. Normalize Content/Body
  const body = data.body || data.content || data.text?.body || "";

  // 3. Normalize From/To/Phone
  const from = data.from || data.phone || "BOT";
  const to   = data.to   || (data.direction === "outgoing" ? data.phone : "BOT");

  const messageTimestamp = data.timestamp ? new Date(data.timestamp) : new Date();

  const normalized = {
    clientId:   data.clientId,
    conversationId: data.conversationId, // CRITICAL: Fix for Live Chat visibility
    from:       from,
    to:         to,
    direction:  normalizeDirection(data.direction, data.type),
    agentId:    data.agentId || null,
    type:       data.messageType || data.type || "text",
    content:    body,
    channel:    data.channel || "whatsapp",
    messageId:  data.messageId || data.wamid || "",
    status:     data.status || "sent",
    mediaUrl:   data.mediaUrl || null,
    timestamp:  messageTimestamp,
    metadata:   data.rawData || data.metadata || null,
    translatedContent: data.translatedContent || '',
    detectedLanguage: data.detectedLanguage || 'en',
    originalText: data.originalText || '',
    voiceTranscript: data.voiceTranscript || '',
    originalType: data.originalType || undefined,
    trainingContext: data.trainingContext || undefined,
  };

  // Remove keys not in schema
  const schemaPaths = Message.schema.paths;
  Object.keys(normalized).forEach(key => {
    if (!schemaPaths[key]) delete normalized[key];
  });

  const createdMessage = await Message.create(normalized);

  // Sync conversation list + SLA timestamps (first customer msg / first reply)
  if (data.conversationId) {
    const convoPatch = {
      lastMessage: body.substring(0, 100),
      lastMessageAt: messageTimestamp,
      lastInteraction: messageTimestamp,
    };
    const conversation = await Conversation.findByIdAndUpdate(
      data.conversationId,
      { $set: convoPatch },
      { new: false }
    )
      .select('phone clientId')
      .lean();

    if (conversation?.phone && conversation?.clientId) {
      const AdLead = require('../../models/AdLead');
      const { phoneVariants } = require('../messaging/cancelAllAutomationsFor');
      const variants = phoneVariants(conversation.phone);
      if (variants.length) {
        const leadPatch = {
          lastInteraction: messageTimestamp,
          lastMessageContent: body.substring(0, 500),
        };
        if (normalized.direction === 'incoming') {
          leadPatch.lastInboundAt = messageTimestamp;
        }
        await AdLead.updateOne(
          { clientId: conversation.clientId, phoneNumber: { $in: variants } },
          { $set: leadPatch }
        ).catch(() => {});
      }
    }
    if (normalized.direction === 'incoming') {
      await Conversation.updateOne(
        { _id: data.conversationId, firstInboundAt: { $exists: false } },
        { $set: { firstInboundAt: messageTimestamp } }
      );
    } else {
      await Conversation.updateOne(
        {
          _id: data.conversationId,
          firstInboundAt: { $exists: true, $ne: null },
          firstResponseAt: { $exists: false },
        },
        { $set: { firstResponseAt: messageTimestamp } }
      );
    }
  }

  return createdMessage;
}

module.exports = { createMessage };
