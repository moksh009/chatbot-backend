const WhatsApp = require('../../meta/whatsapp');
const { sendWorkspaceEmailDirect } = require('../../core/emailService');
const { sendInstagram } = require('./sendInstagram');

async function sendWhatsApp({ client, to, payload }) {
  if (payload.templateName) {
    const response = await WhatsApp.sendTemplate(
      client,
      to,
      payload.templateName,
      payload.templateLanguage || 'en',
      Array.isArray(payload.components) ? payload.components : []
    );
    return { messageId: response?.messages?.[0]?.id || null, raw: response };
  }
  if (payload.interactive) {
    const response = await WhatsApp.sendInteractive(client, to, payload.interactive, payload.text || '');
    return { messageId: response?.messages?.[0]?.id || null, raw: response };
  }
  if (payload.media?.type === 'image') {
    const response = await WhatsApp.sendImage(client, to, payload.media.url, payload.text || '');
    return { messageId: response?.messages?.[0]?.id || null, raw: response };
  }
  const response = await WhatsApp.sendText(client, to, payload.text || '');
  return { messageId: response?.messages?.[0]?.id || null, raw: response };
}

async function sendEmailMessage({ client, to, payload }) {
  const sendOut = await sendWorkspaceEmailDirect(client, {
    to,
    subject: payload.subject || 'Store update',
    html: payload.html || payload.text || '',
    text: payload.text,
    format: payload.format,
  });
  if (!sendOut?.success) {
    throw new Error(sendOut?.error || 'email_send_failed');
  }
  return { messageId: sendOut.messageId || null };
}

module.exports = {
  sendWhatsApp,
  sendEmailMessage,
  sendInstagram,
};
