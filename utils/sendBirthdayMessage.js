const axios = require('axios');
const BirthdayUser = require('../models/BirthdayUser');

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

    console.log(`✅ Birthday message sent to ${recipientPhone}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Failed to send birthday message to ${recipientPhone}:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { sendBirthdayWishWithImage };
