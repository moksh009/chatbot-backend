const axios = require("axios");
const { saveInboundMessage, saveOutboundMessage } = require("./dualBrainEngine");

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
  return await saveInboundMessage(parsedMessage.from, client.clientId, parsedMessage, io, channel);
}

module.exports = {
  sendInstagramMessage,
  sendInstagramReply,
  saveOmnichannelMessage
};
