"use strict";

const Message = require("../models/Message");

const Conversation = require("../models/Conversation");

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
    originalText: data.originalText || ''
  };

  // Remove keys not in schema
  const schemaPaths = Message.schema.paths;
  Object.keys(normalized).forEach(key => {
    if (!schemaPaths[key]) delete normalized[key];
  });

  const createdMessage = await Message.create(normalized);

  // Sync Conversation Sorting Fields
  if (data.conversationId) {
    await Conversation.findByIdAndUpdate(data.conversationId, {
      $set: {
        lastMessage: body.substring(0, 100),
        lastMessageAt: messageTimestamp,
        lastInteraction: messageTimestamp
      }
    });
  }

  return createdMessage;
}

module.exports = { createMessage };
