/**
 * Client outbound email via Nodemailer (same stack as emailService.sendEmail).
 * Inbound webhooks remain a separate HTTP integration (payload shape unchanged).
 */
const emailService = require('./emailService');

/**
 * Sends an email using the workspace's outbound configuration: Gmail OAuth (API)
 * or SMTP (email user + app password), via emailService.sendEmail.
 */
async function sendEmailMessage(client, toEmail, subject, text, html = '') {
  if (!emailService.isWorkspaceEmailReady(client)) {
    throw new Error(
      'Email not configured: connect Gmail (OAuth) in Settings → Integrations, or add SMTP with your sending address and app password.'
    );
  }

  const htmlBody =
    html && String(html).trim()
      ? html
      : `<p>${String(text || '').replace(/\n/g, '<br/>')}</p>`;

  const ok = await emailService.sendEmail(client, {
    to: toEmail,
    subject: subject || '(no subject)',
    html: htmlBody
  });

  if (!ok) {
    throw new Error(
      client.emailMethod === 'gmail_oauth'
        ? 'Gmail send failed. Reconnect Gmail in Settings or check Google API / token access.'
        : 'SMTP send failed. Confirm app password, SMTP_HOST, and try port 465 from your host.'
    );
  }

  const Message = require('../models/Message');
  const fromAddress = client.emailUser || client.gmailAddress || '';
  const msgData = {
    clientId: client.clientId,
    from: fromAddress,
    to: toEmail,
    direction: 'outgoing',
    type: 'text',
    content: subject ? `Subject: ${subject}\n\n${text || ''}` : text || '',
    messageId: `${client.emailMethod === 'gmail_oauth' ? 'gmail' : 'smtp'}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    status: 'sent',
    channel: 'email',
    originalType: 'email'
  };

  return Message.create(msgData);
}

/**
 * Webhook handler for inbound email providers (generic JSON body).
 */
async function handleIncomingEmail(req, res) {
  try {
    const { from, to, subject, text, html, id } = req.body;

    const Client = require('../models/Client');
    const client = await Client.findOne({ emailIdentity: { $regex: new RegExp(to.split('@')[1], 'i') } });

    if (!client) {
      console.log(`[EmailIntegration] No client configured for receiving domain: ${to}`);
      return res.status(200).send('Ignored');
    }

    const senderEmail = (from || '').match(/[\w.-]+@[\w.-]+\.\w+/) ? (from || '').match(/[\w.-]+@[\w.-]+\.\w+/)[0] : from;

    const syntheticMessage = {
      id: id || `email_${Date.now()}`,
      from: senderEmail,
      type: 'text',
      text: { body: text || html || subject },
      channel: 'email',
      subject: subject,
      originalType: 'email'
    };

    const { handleWhatsAppMessage } = require('./dualBrainEngine');
    await handleWhatsAppMessage(senderEmail, syntheticMessage, null, from);

    res.status(200).send('OK');
  } catch (error) {
    console.error('[EmailIntegration] Webhook handler error:', error);
    res.status(500).send('Internal Error');
  }
}

module.exports = {
  sendEmailMessage,
  handleIncomingEmail
};
