const axios = require('axios');
const BirthdayUser = require('../models/BirthdayUser');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Client = require('../models/Client');

// 📤 Send WhatsApp birthday wish with consent check
async function sendBirthdayWishWithImage(recipientPhone, accessToken, phoneNumberId, clientId, templateNameOverride = null) {
  try {
    const apiVersion = process.env.API_VERSION || process.env.WHATSAPP_API_VERSION || 'v18.0';
    const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
    
    // Check if user has consented to birthday messages for this client
    let query = { 
      number: recipientPhone,
      isOpted: true 
    };

    if (clientId) {
        if (clientId === 'code_clinic_v1') {
            query.$or = [{ clientId: clientId }, { clientId: { $exists: false } }];
        } else {
            query.clientId = clientId;
        }
    }

    const birthdayUser = await BirthdayUser.findOne(query);
    
    if (!birthdayUser) {
      console.log(`🎂 Skipping birthday message for ${recipientPhone} - user has not consented to birthday messages for client ${clientId}`);
      return { success: false, reason: 'not_consented' };
    }

    // Determine template name
    // Priority: Override > Client Config > Default
    let templateName = templateNameOverride || "happy_birthday_wish_1";
    
    if (!templateNameOverride && clientId && clientId !== 'code_clinic_v1') {
       try {
         const client = await Client.findOne({ clientId });
         if (client?.config?.templates?.birthday) {
           templateName = client.config.templates.birthday;
         }
       } catch (e) { console.error('Error fetching client config for template:', e); }
    }

    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const response = await axios.post(
        url,
        {
          messaging_product: "whatsapp",
          to: recipientPhone,
          type: "template",
          template: {
            name: templateName, // Dynamic template name
            language: { code: templateLang },
            components: [
              {
                type: "header",
                parameters: [
                  {
                    type: "image",
                    image: {
                      link: "https://ttfalmsbucket.s3.ap-south-1.amazonaws.com/TMGESP/hbd.jpg"
                    }
                  }
                ]
              },
              {
                type: "body",
                parameters: [
                  {
                    type: "text",
                    parameter_name:"name_of_person",
                    text: "Friend"
                  }
                ]
              }
            ]
          }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          }
        }
      );
    console.log('Birthday API response:', response.status, response.data);

    try {
      // Use provided clientId or fallback
      const finalClientId = clientId || 'code_clinic_v1';
      
      let conversation = await Conversation.findOne({ phone: recipientPhone, clientId: finalClientId });
      if (!conversation) {
        conversation = await Conversation.create({ phone: recipientPhone, clientId: finalClientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
      }
      const saved = await Message.create({
        clientId: finalClientId,
        conversationId: conversation._id,
        from: 'bot',
        to: recipientPhone,
        content: 'Birthday wish',
        type: 'template',
        direction: 'outgoing',
        status: 'sent'
      });
      conversation.lastMessage = 'Birthday wish';
      conversation.lastMessageAt = new Date();
      await conversation.save();
    } catch (err) {
        console.error('Error saving conversation/message:', err);
    }

    return { success: true };
  } catch (error) {
    console.error(`❌ Failed to send birthday message to ${recipientPhone}:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { sendBirthdayWishWithImage };
