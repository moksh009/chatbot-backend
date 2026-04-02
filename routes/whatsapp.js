const express = require('express');
const router = express.Router();
const axios = require('axios');
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const log = require('../utils/logger')('WhatsAppAPI');
const { decrypt } = require('../utils/encryption');
const { translateWhatsAppError } = require('../utils/whatsappErrors');

// @route   POST /api/whatsapp/send-template
// @desc    Send an individual WhatsApp template message
// @access  Private
router.post('/send-template', protect, async (req, res) => {
  const { clientId, phoneNumber, templateName, languageCode, components } = req.body;

  if (!phoneNumber || !templateName) {
    return res.status(400).json({ success: false, message: 'phoneNumber and templateName are required' });
  }

  let targetClientId = 'unknown';
  try {
    // If Super Admin, use provided clientId, otherwise use user's own
    targetClientId = (req.user.role === 'SUPER_ADMIN' && clientId) ? clientId : req.user.clientId;
    
    const client = await Client.findOne({ clientId: targetClientId });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client configuration not found' });
    }

    const phoneNumberId = client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
    
    // --- ROOT CAUSE FIX: Decrypt the token if it exists in the DB ---
    let accessToken = process.env.WHATSAPP_TOKEN;
    if (client.whatsappToken) {
        try {
            accessToken = decrypt(client.whatsappToken);
        } catch (decErr) {
            log.error(`Failed to decrypt WhatsApp token for ${targetClientId}`, decErr.message);
            // Fallback to env or raw (though raw will likely fail at Meta)
            accessToken = client.whatsappToken; 
        }
    }

    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({ success: false, message: 'WhatsApp credentials (Phone ID/Token) not configured for this client' });
    }

    const apiVersion = process.env.API_VERSION || 'v18.0';
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode || 'en' },
        components: components || []
      }
    };

    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });

    log.info(`Individual template sent: ${templateName} to ${phoneNumber} (clientId: ${targetClientId})`);
    
    // Create Message record for tracking
    try {
        const Message = require('../models/Message');
        const metaMessageId = response.data?.messages?.[0]?.id;
        
        await Message.create({
            clientId: targetClientId,
            from: phoneNumberId,
            to: phoneNumber,
            direction: 'outgoing',
            type: 'template',
            content: `[Individual Outreach] Template: ${templateName}`,
            messageId: metaMessageId,
            status: 'sent',
            campaignId: req.body.campaignId || null, 
            channel: 'whatsapp'
        });
    } catch (msgErr) {
        log.error('Failed to create message record for tracking', msgErr.message);
    }

    res.json({ success: true, data: response.data, messageId: response.data?.messages?.[0]?.id });

  } catch (error) {
    const errorData = error.response?.data || error.message;
    const statusCode = error.response?.status || 500;
    
    log.error('Failed to send individual template', { clientId: targetClientId, error: errorData });

    // --- LOGOUT PREVENTION FIX: Map 401 to 400 for the frontend ---
    const finalStatus = statusCode === 401 ? 400 : statusCode;
    
    const friendlyMessage = translateWhatsAppError(errorData);

    res.status(finalStatus).json({ 
      success: false, 
      message: friendlyMessage, 
      details: errorData 
    });
  }
});

module.exports = router;
