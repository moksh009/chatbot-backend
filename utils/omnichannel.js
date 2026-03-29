const axios = require("axios");
/**
 * Sends a rich message reply to an Instagram user via Meta Graph API
 */
async function sendInstagramMessage(client, recipientId, messageData) {
  if (!client.instagramAccessToken) {
    throw new Error("Instagram Access Token missing for client");
  }
  
  // Use either the Page ID or 'me' if it's the token's owner
  const accountId = client.instagramPageId || "me";
  
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v18.0/${accountId}/messages`,
      {
        recipient: { id: recipientId },
        message:   messageData,
        messaging_type: "RESPONSE" // Required for many IG message types
      },
      {
        headers: { Authorization: `Bearer ${client.instagramAccessToken}` }
      }
    );

    // Lazy load saveOutboundMessage to avoid circular dependencies
    const { saveOutboundMessage } = require("./dualBrainEngine");
    if (saveOutboundMessage) {
       await saveOutboundMessage(recipientId, client.clientId, 'text', messageData.text || '[IG Message]', res.data.message_id || '', 'instagram');
    }

    return res.data;
  } catch (err) {
    console.error("[Omnichannel] Instagram send error:", JSON.stringify(err.response?.data || err.message));
    throw err;
  }
}

/**
 * Legacy wrapper for simple text
 */
async function sendInstagramReply(client, recipientId, text) {
  return await sendInstagramMessage(client, recipientId, { text });
}

/**
 * Normalizes and saves an inbound message from non-WhatsApp channels (IG, Email)
 */
async function saveOmnichannelMessage(parsedMessage, client, channel) {
  const io = global.io;
  const { saveInboundMessage } = require("./dualBrainEngine");
  if (!saveInboundMessage) return null;
  return await saveInboundMessage(parsedMessage.from, client.clientId, parsedMessage, io, channel);
}

module.exports = {
  sendInstagramMessage,
  sendInstagramReply,
  saveOmnichannelMessage
};
