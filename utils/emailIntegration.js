const { Resend } = require('resend');

/**
 * Sends an email using the client's Resend configuration.
 * Automatically saves the message in the DB and returns the Message record.
 */
async function sendEmailMessage(client, toEmail, subject, text, html = '') {
  if (!client.resendApiKey || !client.emailIdentity) {
    throw new Error('Email channel not configured. Missing Resend API Key or Identity.');
  }

  const resend = new Resend(client.resendApiKey);
  
  // Format the sender correctly
  // E.g., client.emailIdentity might be "support@company.com" or "Company Support <support@company.com>"
  const fromName = client.name || 'Support';
  const fromAddress = client.emailIdentity.includes('@') ? client.emailIdentity : `support@${client.emailIdentity}`;
  let formattedFrom = client.emailIdentity;
  if (!formattedFrom.includes('<')) {
    formattedFrom = `${fromName} <${fromAddress}>`;
  }

  try {
    const response = await resend.emails.send({
      from: formattedFrom,
      to: [toEmail],
      subject: subject,
      text: text,
      html: html || `<p>${text.replace(/\n/g, '<br/>')}</p>`
    });

    if (response.error) {
       console.error('[EmailIntegration] Send failed:', response.error);
       throw new Error(response.error.message);
    }

    const { id: externalId } = response.data;
    
    // Save to DB
    const Message = require('../models/Message');
    const msgData = {
      clientId: client.clientId,
      from: fromAddress,
      to: toEmail,
      direction: 'outgoing',
      type: 'text',
      content: subject ? `Subject: ${subject}\n\n${text}` : text,
      messageId: externalId,
      status: 'sent',
      channel: 'email',
      originalType: 'email'
    };

    const newMsg = await Message.create(msgData);
    return newMsg;

  } catch (error) {
    console.error('[EmailIntegration] Error:', error.message);
    throw error;
  }
}

/**
 * Webhook handler for Resend (incoming emails).
 * Requires setting up a receiving endpoint in Resend.
 * Transforms it to DualBrainEngine format.
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
    // Using handleWhatsAppMessage as the universal router
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
