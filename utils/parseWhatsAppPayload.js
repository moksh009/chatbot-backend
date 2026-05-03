"use strict";

/**
 * Robust WhatsApp Webhook Payload Parser
 * Extracts message content, type, and sender info across all message formats.
 */
function parseWhatsAppPayload(body) {
  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    
    // 1. Basic Validation
    if (!value || (!value.messages && !value.statuses)) return null;

    // 2. Handle Status Updates (sent, delivered, read)
    if (value.statuses && value.statuses.length > 0) {
      const status = value.statuses[0];
      return {
        type: 'status_update',
        messageId: status.id,
        status: status.status, // "delivered", "read", "failed", "sent"
        recipientId: status.recipient_id,
        timestamp: status.timestamp,
        phoneNumberId: metadata?.phone_number_id,
        errors: status.errors
      };
    }

    const messages = value.messages?.[0];
    if (!messages) return null;

    const contact = value.contacts?.[0];
    const metadata = value.metadata;

    // 3. Extract Core Data
    const parsed = {
      from: messages.from,
      phone: messages.from,
      messageId: messages.id,
      timestamp: messages.timestamp,
      type: messages.type,
      profileName: contact?.profile?.name || "",
      phoneNumberId: metadata?.phone_number_id,
      channel: "whatsapp",
      rawData: body
    };

    // Reply context (e.g. user tapped a button on a specific prior message) — optional for routing.
    if (messages.context && (messages.context.id || messages.context.from)) {
      parsed.context = {
        from: messages.context.from,
        id: messages.context.id,
      };
    }

    // 4. Extract Content based on Type
    switch (messages.type) {
      case "text":
        parsed.text = { body: messages.text?.body || "" };
        break;
      
      case "interactive": {
        const interactive = messages.interactive;
        if (interactive.button_reply) {
          parsed.interactive = { 
            type: "button_reply",
            button_reply: { id: interactive.button_reply.id, title: interactive.button_reply.title }
          };
        } else if (interactive.list_reply) {
          parsed.interactive = { 
            type: "list_reply",
            list_reply: { id: interactive.list_reply.id, title: interactive.list_reply.title, description: interactive.list_reply.description }
          };
        } else if (interactive.nfm_reply) {
          // Meta Flow response
          parsed.interactive = {
            type: "nfm_reply",
            nfm_reply: interactive.nfm_reply
          };
        }
        break;
      }

      case "image":
        parsed.image = { id: messages.image.id, mime_type: messages.image.mime_type, caption: messages.image.caption };
        break;
      
      case "audio":
        parsed.audio = { id: messages.audio.id, mime_type: messages.audio.mime_type, voice: messages.audio.voice };
        break;
      
      case "video":
        parsed.video = { id: messages.video.id, mime_type: messages.video.mime_type, caption: messages.video.caption };
        break;

      case "document":
        parsed.document = { id: messages.document.id, mime_type: messages.document.mime_type, filename: messages.document.filename, caption: messages.document.caption };
        break;
      
      case "button":
        // Legacy button type
        parsed.button = { text: messages.button.text, payload: messages.button.payload };
        break;

      case "reaction":
        parsed.reaction = messages.reaction;
        break;

      case "location":
        parsed.location = messages.location;
        break;

      case "contacts":
        parsed.contacts = messages.contacts;
        break;

      default:
        console.warn(`[Parser] Unknown message type: ${messages.type}`);
    }

    return parsed;
  } catch (err) {
    console.error("[Parser] Critical Parse Error:", err.message);
    return null;
  }
}

module.exports = { parseWhatsAppPayload };
