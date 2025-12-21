const axios = require('axios');
const BirthdayUser = require('../models/BirthdayUser');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Client = require('../models/Client');

// 📤 Send WhatsApp birthday wish with consent check
async function sendBirthdayWishWithImage(recipientPhone, accessToken, phoneNumberId) {
  try {
    // Check if user has consented to birthday messages
    const birthdayUser = await BirthdayUser.findOne({ 
      number: recipientPhone,
      isOpted: true 
    });
    
    if (!birthdayUser) {
      console.log(`🎂 Skipping birthday message for ${recipientPhone} - user has not consented to birthday messages`);
      return { success: false, reason: 'not_consented' };
    }

    const response = await axios.post(
        `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to: recipientPhone,
          type: "template",
          template: {
            name: "happy_birthday_wish_1", // must match exactly
            language: { code: "en" },
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

    try {
      const client = await Client.findOne({ phoneNumberId });
      const clientId = client ? client.clientId : 'code_clinic_v1';
      let conversation = await Conversation.findOne({ phone: recipientPhone, clientId });
      if (!conversation) {
        conversation = await Conversation.create({ phone: recipientPhone, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
      }
      const saved = await Message.create({
        clientId,
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
    } catch {}

    return { success: true };
  } catch (error) {
    console.error(`❌ Failed to send birthday message to ${recipientPhone}:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { sendBirthdayWishWithImage };
