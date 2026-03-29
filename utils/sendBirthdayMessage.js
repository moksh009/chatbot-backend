const Client = require('../models/Client');
const WhatsApp = require('./whatsapp');
const { createMessage } = require('./createMessage');
const Conversation = require('../models/Conversation');

// 📤 Send WhatsApp birthday wish with consent check
async function sendBirthdayWishWithImage(recipientPhone, unused_token, unused_phoneId, clientId, templateNameOverride = null) {
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return { success: false, reason: 'client_not_found' };

    // Determine template name
    let templateName = templateNameOverride || (client.config?.templates?.birthday) || "happy_birthday_wish_1";
    
    const components = [
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
            text: "Friend"
          }
        ]
      }
    ];

    await WhatsApp.sendTemplate(client, recipientPhone, templateName, 'en_US', components);

    // Save to DB
    const newMessage = await createMessage({
        clientId: client.clientId,
        phone: recipientPhone,
        direction: 'outbound',
        type: 'template',
        body: `[Birthday Wish: ${templateName}]`
    });

    return { success: true, messageId: newMessage._id };
  } catch (error) {
    console.error(`❌ Failed to send birthday message to ${recipientPhone}:`, error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { sendBirthdayWishWithImage };
