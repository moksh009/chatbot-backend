const express = require('express');
const router = express.Router();
const axios = require('axios');
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const log = require('../utils/logger')('WhatsAppAPI');
const WhatsApp = require('../utils/whatsapp');
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

    const responseData = await WhatsApp.sendTemplate(
        client, 
        phoneNumber, 
        templateName, 
        languageCode || 'en', 
        components || []
    );

    log.info(`Individual template sent: ${templateName} to ${phoneNumber} (clientId: ${targetClientId})`);
    
    // Create Message record for tracking
    try {
        const Message = require('../models/Message');
        const metaMessageId = responseData?.messages?.[0]?.id;
        const phoneNumberId = client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
        
        // --- FIX: Sanitize campaignId to ensure it's a valid ObjectId or null ---
        let sanitizedCampaignId = req.body.campaignId;
        if (typeof sanitizedCampaignId === 'string' && !sanitizedCampaignId.match(/^[0-9a-fA-F]{24}$/)) {
            sanitizedCampaignId = null;
        }

        const newMessage = await Message.create({
            clientId: targetClientId,
            from: phoneNumberId,
            to: phoneNumber,
            direction: 'outgoing',
            type: 'template',
            content: `[Individual Outreach] Template: ${templateName}`,
            messageId: metaMessageId,
            status: 'sent',
            campaignId: sanitizedCampaignId, 
            channel: 'whatsapp'
        });

        // --- REAL-TIME SYNC: Emit socket events so UI updates immediately ---
        const io = req.app.get('socketio');
        if (io) {
            io.to(`client_${targetClientId}`).emit('new_message', newMessage);
            // Also trigger conversation list update
            const Conversation = require('../models/Conversation');
            const conv = await Conversation.findOneAndUpdate(
                { phone: phoneNumber, clientId: targetClientId },
                { 
                  lastMessage: `[Template: ${templateName}]`, 
                  lastMessageAt: new Date(),
                  $setOnInsert: { 
                    customerName: '', 
                    status: 'BOT_ACTIVE', 
                    channel: 'whatsapp' 
                  }
                },
                { new: true, upsert: true }
            );
            if (conv) {
                // Link message to conversation
                newMessage.conversationId = conv._id;
                await newMessage.save();
                io.to(`client_${targetClientId}`).emit('conversation_update', conv);
            }
        }

    } catch (msgErr) {
        log.error('Failed to create message record for tracking', msgErr.message);
    }

    res.json({ success: true, data: responseData, messageId: responseData?.messages?.[0]?.id });

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
