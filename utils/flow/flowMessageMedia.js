/**
 * Message node media normalization — backend mirror of frontend flowMessageMedia.js
 */
function normalizeMessageNodeData(data = {}) {
  const imageUrl = String(data?.imageUrl || '').trim();
  const hasUrl = !!imageUrl;
  const sendImage =
    hasUrl && (data?.sendImage === true || (data?.sendImage !== false && hasUrl));
  return {
    ...data,
    imageUrl,
    sendImage: sendImage && hasUrl,
  };
}

function shouldSendMessageImage(data = {}) {
  const normalized = normalizeMessageNodeData(data);
  const url = normalized.imageUrl;
  return normalized.sendImage && url && /^https?:\/\//i.test(url);
}

module.exports = {
  normalizeMessageNodeData,
  shouldSendMessageImage,
};
