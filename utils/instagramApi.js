"use strict";

const axios = require('axios');

/**
 * Sends a private DM to an Instagram user (used for Comment-to-DM or direct messaging)
 */
async function sendInstagramDM(igUserId, messageData, accessToken) {
  if (!accessToken) throw new Error('Missing Instagram Access Token');
  
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${accessToken}`;
  
  // Build Message Body
  const message = {};
  if (messageData.text) {
    message.text = messageData.text;
  }
  
  // If buttons/templates are provided (Note: IG Graph API standard)
  if (messageData.buttons && messageData.buttons.length > 0) {
    // Note: IG uses Generic Template for buttons in DMs
    message.attachment = {
      type: "template",
      payload: {
        template_type: "generic",
        elements: [{
          title: messageData.text || "Action",
          buttons: messageData.buttons.map(b => ({
            type: "web_url",
            url: b.url,
            title: b.title
          }))
        }]
      }
    };
    delete message.text; // Mutually exclusive in some payload versions, but Generic Template handles text in `title`
  }

  const payload = {
    recipient: { id: igUserId },
    message: message
  };

  try {
    const res = await axios.post(url, payload);
    return res.data;
  } catch (error) {
    console.error('[IG API] Send DM failed:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Replies publicly to an Instagram Comment
 */
async function replyToInstagramComment(commentId, replyText, accessToken) {
  if (!accessToken) throw new Error('Missing Instagram Access Token');
  
  const url = `https://graph.facebook.com/v18.0/${commentId}/replies?access_token=${accessToken}`;
  
  try {
    const res = await axios.post(url, { message: replyText });
    return res.data;
  } catch (error) {
    console.error('[IG API] Reply to Comment failed:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  sendInstagramDM,
  replyToInstagramComment
};
