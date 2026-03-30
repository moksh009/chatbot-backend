"use strict";

const Message = require("../models/Message");

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
    timestamp:  data.timestamp || new Date(),
    metadata:   data.rawData || data.metadata || null
  };

  // Remove keys not in schema
  const schemaPaths = Message.schema.paths;
  Object.keys(normalized).forEach(key => {
    if (!schemaPaths[key]) delete normalized[key];
  });

  return await Message.create(normalized);
}

module.exports = { createMessage };
