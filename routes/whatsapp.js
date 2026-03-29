const express = require('express');
const router = express.Router();
const axios = require('axios');
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const log = require('../utils/logger')('WhatsAppAPI');

// @route   POST /api/whatsapp/send-template
// @desc    Send an individual WhatsApp template message
// @access  Private
router.post('/send-template', protect, async (req, res) => {
  const { clientId, phoneNumber, templateName, languageCode, components } = req.body;

  if (!phoneNumber || !templateName) {
    return res.status(400).json({ success: false, message: 'phoneNumber and templateName are required' });
  }

  try {
    // If Super Admin, use provided clientId, otherwise use user's own
    const targetClientId = (req.user.role === 'SUPER_ADMIN' && clientId) ? clientId : req.user.clientId;
    
    const client = await Client.findOne({ clientId: targetClientId });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client configuration not found' });
    }

    const phoneNumberId = client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
    const accessToken = client.whatsappToken || process.env.WHATSAPP_TOKEN;

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
            campaignId: req.body.campaignId || null, // Link to campaign if provided
            channel: 'whatsapp'
        });
    } catch (msgErr) {
        log.error('Failed to create message record for tracking', msgErr.message);
    }

    res.json({ success: true, data: response.data, messageId: response.data?.messages?.[0]?.id });

  } catch (error) {
    const errorData = error.response?.data || error.message;
    log.error('Failed to send individual template', { error: errorData });
    res.status(error.response?.status || 500).json({ 
      success: false, 
      message: 'Failed to send WhatsApp template', 
      details: errorData 
    });
  }
});

module.exports = router;
