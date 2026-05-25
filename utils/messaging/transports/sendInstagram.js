const { decrypt } = require('../../core/encryption');
const { sendInstagramDMv2, replyToCommentv2 } = require('../../meta/igGraphApi');

function resolveIgAccessToken(client) {
  const raw = client?.instagramAccessToken || client?.igAccessToken || client?.social?.instagram?.accessToken;
  if (!raw) return null;
  return decrypt(raw) || raw;
}

/**
 * Instagram outbound transport for sendEnvelope.
 * payload.igDm — { recipient, message } Graph messaging body
 * payload.igCommentReply — { commentId, message }
 */
async function sendInstagram({ client, payload = {} }) {
  const accessToken = resolveIgAccessToken(client);
  if (!accessToken) {
    throw new Error('instagram_not_connected');
  }

  if (payload.igCommentReply?.commentId) {
    const { commentId, message } = payload.igCommentReply;
    await replyToCommentv2(commentId, message, accessToken, { clientId: client.clientId });
    return { messageId: null };
  }

  const igDm = payload.igDm || payload;
  const recipientId = igDm.recipient?.id || payload.recipientId;
  const message = igDm.message || payload.message;
  if (!recipientId || !message) {
    throw new Error('ig_dm_payload_invalid');
  }

  const data = await sendInstagramDMv2(recipientId, message, accessToken, {
    clientId: client.clientId,
    commentId: payload.commentId,
  });
  return { messageId: data?.message_id || data?.id || null, raw: data };
}

module.exports = { sendInstagram, resolveIgAccessToken };
