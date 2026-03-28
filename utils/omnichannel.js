const axios = require("axios");
const { saveInboundMessage, saveOutboundMessage } = require("./dualBrainEngine");

/**
 * Sends a message reply to an Instagram user via Meta Graph API
 */
async function sendInstagramReply(client, recipientId, text) {
  if (!client.instagramPageId || !client.instagramAccessToken) {
    throw new Error("Instagram credentials missing for client");
  }
  
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v18.0/${client.instagramPageId}/messages`,
      {
        recipient: { id: recipientId },
        message:   { text }
      },
      {
        headers: { Authorization: `Bearer ${client.instagramAccessToken}` }
      }
    );
    return res.data;
  } catch (err) {
    console.error("[Omnichannel] Instagram send error:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Normalizes and saves an inbound message from non-WhatsApp channels (IG, Email)
 */
async function saveOmnichannelMessage(parsedMessage, client, channel) {
  const io = global.io;
  return await saveInboundMessage(parsedMessage.from, client.clientId, parsedMessage, io, channel);
}

module.exports = {
  sendInstagramReply,
  saveOmnichannelMessage
};
