const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Client = require('../../models/Client');

// Helper to send plain WhatsApp text message
async function sendWhatsAppText({ phoneNumberId, to, body, io }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  };
  try {
    await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
    await saveAndEmitMessage({ phoneNumberId, to, body, type: 'text', io });
  } catch (err) {
    console.error('Error sending WhatsApp text:', err.response?.data || err.message);
  }
}

// Helper to send WhatsApp Image
async function sendWhatsAppImage({ phoneNumberId, to, imageUrl, caption, io }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { 
        link: imageUrl,
        caption: caption || ''
    }
  };
  try {
    await axios.post(url, data, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    await saveAndEmitMessage({ phoneNumberId, to, body: `[Image] ${caption}`, type: 'image', io });
  } catch (err) {
    console.error('Error sending WhatsApp image:', err.response?.data || err.message);
  }
}

// Helper to send WhatsApp Interactive Message (Buttons/Lists)
async function sendWhatsAppInteractive({ phoneNumberId, to, body, interactive, io }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
        type: interactive.type, // 'button' or 'list'
        body: { text: body },
        action: interactive.action
    }
  };
  
  if (interactive.header) {
      data.interactive.header = interactive.header;
  }
  if (interactive.footer) {
      data.interactive.footer = interactive.footer;
  }

  try {
    await axios.post(url, data, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    await saveAndEmitMessage({ phoneNumberId, to, body: `[Interactive] ${body}`, type: 'interactive', io });
  } catch (err) {
    console.error('Error sending WhatsApp interactive:', err.response?.data || err.message);
  }
}

// Helper to save message and emit socket
async function saveAndEmitMessage({ phoneNumberId, to, body, type, io }) {
    try {
      const client = await Client.findOne({ phoneNumberId });
      const resolvedClientId = client ? client.clientId : 'delitech_smarthomes';
      let conversation = await Conversation.findOne({ phone: to, clientId: resolvedClientId });
      if (!conversation) {
        conversation = await Conversation.create({ phone: to, clientId: resolvedClientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
      }
      const savedMessage = await Message.create({
        clientId: resolvedClientId,
        conversationId: conversation._id,
        from: 'bot',
        to,
        content: body,
        type: type,
        direction: 'outgoing',
        status: 'sent'
      });
      conversation.lastMessage = body;
      conversation.lastMessageAt = new Date();
      await conversation.save();
      if (io) {
        io.to(`client_${resolvedClientId}`).emit('new_message', savedMessage);
        io.to(`client_${resolvedClientId}`).emit('conversation_update', conversation);
      }
    } catch (dbErr) {
        console.error('Error saving bot message:', dbErr);
    }
}

// AI Helper
async function getAIResponse(query) {
  try {
    // Check if openai is installed and key is present
    const OpenAI = require('openai');
    if (!process.env.OPENAI_API_KEY) {
        return "I am currently unable to access my AI brain (Missing API Key). But I can help you with the menu options!";
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const kbPath = path.join(__dirname, '../../utils/delitechKnowledgeBase.txt');
    let kbContent = '';
    try {
        kbContent = fs.readFileSync(kbPath, 'utf8');
    } catch (e) {
        kbContent = "Delitech Smart Home sells wireless video doorbells with 5MP cameras, two-way audio, and night vision.";
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: `You are a friendly and helpful AI assistant for Delitech Smart Home. Use the following knowledge base to answer user questions concisely and professionally.\n\n${kbContent}` },
        { role: "user", content: query }
      ],
      max_tokens: 150
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error('AI Error:', err);
    if (err.status === 429) {
         return "I am currently experiencing high traffic. Please browse our products using the menu below.";
    }
    return "I apologize, I'm having trouble processing that request right now. Please select an option from the menu.";
  }
}

// Admin Notification Helper
async function notifyAdmin({ phoneNumberId, userPhone, userMessage, io }) {
    const adminPhone = process.env.ADMIN_PHONE_NUMBER; 
    
    if (!adminPhone) {
        console.log("Admin phone missing for notification.");
        return;
    }

    const body = `🚨 *New Agent Request*\nUser: ${userPhone}\nMessage: ${userMessage || 'User requested to talk to an agent.'}`;
    await sendWhatsAppText({ phoneNumberId, to: adminPhone, body, io });
}

// --- MAIN FLOW LOGIC ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, io }) {
  const userMsgType = messages.type;
  let userMsg = '';
  let interactiveId = '';

  if (userMsgType === 'text') {
      userMsg = messages.text.body;
  } else if (userMsgType === 'interactive') {
      if (messages.interactive.type === 'button_reply') {
          interactiveId = messages.interactive.button_reply.id;
          userMsg = messages.interactive.button_reply.title;
      } else if (messages.interactive.type === 'list_reply') {
          interactiveId = messages.interactive.list_reply.id;
          userMsg = messages.interactive.list_reply.title;
      }
  }

  // 1. AD TRIGGER FLOW
  const adMessagePattern = /details on this product/i;
  if (userMsgType === 'text' && adMessagePattern.test(userMsg)) {
      // Logic: Create Lead -> Send Welcome Image + Menu
      try {
        let lead = await AdLead.findOne({ phoneNumber: from });
        if (!lead) lead = await AdLead.create({ phoneNumber: from });

        const shopifyBaseUrl = 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'; 
        const shopifyUrl = `${shopifyBaseUrl}?uid=${lead._id}`;

        // Send Interactive Message with Image Header
        await sendWhatsAppInteractive({
            phoneNumberId,
            to: from,
            body: `Welcome to Delitech Smart Home! 🏠\n\nHere is the Wireless Video Doorbell you are interested in.\n\n🛒 *Buy Now*: ${shopifyUrl}`,
            interactive: {
                type: 'button',
                header: {
                    type: 'image',
                    image: {
                        link: 'https://delitechsmarthome.in/cdn/shop/files/1_1.png'
                    }
                },
                action: {
                    buttons: [
                        { type: 'reply', reply: { id: 'btn_products', title: 'View More Products' } },
                        { type: 'reply', reply: { id: 'btn_agent', title: 'Talk to Agent' } }
                    ]
                }
            },
            io
        });


      } catch (err) {
          console.error('Error in ad flow:', err);
          await sendMainMenu({ phoneNumberId, to: from, io });
      }
      return res.status(200).end();
  }

  // 2. GREETING FLOW (Hi/Hello)
  const greetingPattern = /^(hi|hello|hey|hola)/i;
  if (userMsgType === 'text' && greetingPattern.test(userMsg)) {
      await sendMainMenu({ phoneNumberId, to: from, io });
      return res.status(200).end();
  }

  // 3. INTERACTIVE BUTTON HANDLERS
  if (interactiveId) {
      switch (interactiveId) {
          case 'btn_products':
              await sendProductList({ phoneNumberId, to: from, io });
              break;
          case 'btn_faqs':
              await sendWhatsAppText({ phoneNumberId, to: from, body: "🤖 *Ask me anything!*\n\nI can answer questions about installation, battery life, features, and more. Just type your question below!", io });
              break;
          case 'btn_features':
              await sendFeatures({ phoneNumberId, to: from, io });
              break;
          case 'btn_agent':
              await sendWhatsAppText({ phoneNumberId, to: from, body: "📞 connecting you to an agent... An admin has been notified and will message you shortly.", io });
              await notifyAdmin({ phoneNumberId, userPhone: from, userMessage: "User requested agent via menu", io });
              // Set conversation status to HUMAN_TAKEOVER? (Optional, requires DB update)
              break;
          case 'product_1': // Doorbell 5MP
               await sendProductDetail({ 
                   phoneNumberId, to: from, io, 
                   name: 'Wireless Video Doorbell 5MP',
                   img: 'https://delitechsmarthome.in/cdn/shop/files/1_1.png',
                   url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'
               });
               break;
          case 'product_2': // Chime (Placeholder)
               await sendProductDetail({ 
                   phoneNumberId, to: from, io, 
                   name: 'Indoor Chime',
                   img: 'https://delitechsmarthome.in/cdn/shop/files/chime.png', // Placeholder
                   url: 'https://delitechsmarthome.in/products/indoor-chime'
               });
               break;
          default:
               await sendMainMenu({ phoneNumberId, to: from, io });
      }
      return res.status(200).end();
  }

  // 4. GENERAL TEXT / AI FALLBACK
  // If not ad, not greeting, and not button -> Assume it's a question
  if (userMsgType === 'text') {
      const aiReply = await getAIResponse(userMsg);
      await sendWhatsAppText({ phoneNumberId, to: from, body: aiReply, io });
      
      if (aiReply.includes("menu below") || aiReply.includes("trouble processing")) {
          await sendMainMenu({ phoneNumberId, to: from, io });
      }
  }

  res.status(200).end();
}

// --- SUB-FUNCTIONS ---

async function sendMainMenu({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: "How can I assist you today? Select an option below:",
        interactive: {
            type: 'button',
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'btn_products', title: 'Our Products' } },
                    { type: 'reply', reply: { id: 'btn_faqs', title: 'FAQs' } },
                    { type: 'reply', reply: { id: 'btn_agent', title: 'Talk to Agent' } }
                ]
            }
        },
        io
    });
    // Note: WhatsApp allows max 3 buttons. 'Features' can be under Products or a separate list if needed.
    // I'll add 'Features' as a keyword or put it in a List message if I want more options.
    // For now, I stick to 3 buttons for simplicity as requested.
}

async function sendProductList({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: "Check out our top products:",
        interactive: {
            type: 'list',
            header: { type: 'text', text: 'Product Catalog' },
            action: {
                button: 'View Products',
                sections: [
                    {
                        title: 'Smart Home Devices',
                        rows: [
                            { id: 'product_1', title: 'Video Doorbell 5MP', description: 'Wireless, HD Camera, Night Vision' },
                            { id: 'product_2', title: 'Indoor Chime', description: 'Loud ringer for doorbell' }
                        ]
                    },
                    {
                        title: 'More Info',
                        rows: [
                            { id: 'btn_features', title: 'View All Features', description: 'Detailed specs of Doorbell' }
                        ]
                    }
                ]
            }
        },
        io
    });
}

async function sendProductDetail({ phoneNumberId, to, io, name, img, url }) {
    // Get Lead ID for URL tracking
    let lead = await AdLead.findOne({ phoneNumber: to });
    const uid = lead ? lead._id : 'general';
    const finalUrl = `${url}?uid=${uid}`;

    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: `*${name}*\n\nTop quality smart home security.\n\n� *Buy Now*: ${finalUrl}`,
        interactive: {
            type: 'button',
            header: {
                type: 'image',
                image: {
                    link: img
                }
            },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'btn_products', title: 'Other Products' } },
                    { type: 'reply', reply: { id: 'btn_main_menu', title: 'Main Menu' } }
                ]
            }
        },
        io
    });
}

async function sendFeatures({ phoneNumberId, to, io }) {
    const features = `🌟 *Delitech Video Doorbell Features* 🌟\n\n✅ *5MP HD Video*: Crystal clear footage.\n✅ *Two-Way Audio*: Talk to visitors remotely.\n✅ *Night Vision*: See clearly in the dark.\n✅ *Motion Detection*: Instant alerts on your phone.\n✅ *Wireless*: Easy installation, battery powered.\n✅ *Weatherproof*: Designed for outdoors.`;
    await sendWhatsAppText({ phoneNumberId, to, body: features, io });
    // Follow up with "Buy Now" button?
    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: "Interested?",
        interactive: {
            type: 'button',
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'product_1', title: 'Buy Now' } },
                    { type: 'reply', reply: { id: 'btn_main_menu', title: 'Main Menu' } }
                ]
            }
        },
        io
    });
}


router.post('/', async (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);

  try {
    const entry = req.body.entry && req.body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;
    const phoneNumberId = value && value.metadata && value.metadata.phone_number_id;
    const messages = value && value.messages && value.messages[0];
    const from = messages && messages.from;

    // Only process if this is a real user message
    if (!messages || !from) {
      return res.status(200).end();
    }

    // --- DASHBOARD LOGIC START ---
    let clientId = 'delitech_smarthomes';
    try {
      if (phoneNumberId) {
        const client = await Client.findOne({ phoneNumberId });
        if (client) {
          clientId = client.clientId;
        }
      }
    } catch (e) {
      console.error('Client lookup failed:', e.message);
    }
    const io = req.app.get('socketio');

    // 1. Find or Create Conversation
    let conversation = await Conversation.findOne({ phone: from, clientId });
    if (!conversation) {
      conversation = await Conversation.create({
        phone: from,
        clientId,
        status: 'BOT_ACTIVE',
        lastMessageAt: new Date(),
        summary: 'New User'
      });
    }

    // 2. Save Incoming Message
    const userMsgContent = messages.type === 'text' ? messages.text.body : 
                           messages.type === 'interactive' ? (messages.interactive.button_reply?.title || messages.interactive.list_reply?.title) : 
                           `[${messages.type}]`;

    const savedMsg = await Message.create({
      clientId,
      conversationId: conversation._id,
      from,
      to: 'bot', 
      content: userMsgContent,
      type: messages.type,
      direction: 'incoming',
      messageId: messages.id,
      status: 'received'
    });

    // 3. Update Conversation
    conversation.lastMessage = userMsgContent;
    conversation.lastMessageAt = new Date();
    if (conversation.status === 'HUMAN_TAKEOVER') {
      conversation.unreadCount += 1;
    }
    await conversation.save();

    // 4. Emit Socket Event
    if (io) {
      io.to(`client_${clientId}`).emit('new_message', savedMsg);
      io.to(`client_${clientId}`).emit('conversation_update', conversation);
    }

    // 5. Check Takeover Status
    if (conversation.status === 'HUMAN_TAKEOVER') {
      console.log(`Conversation ${conversation._id} is in HUMAN_TAKEOVER mode. Bot paused.`);
      return res.status(200).end();
    }
    // --- DASHBOARD LOGIC END ---

    // Trigger the simplified user flow
    await handleUserChatbotFlow({ from, phoneNumberId, messages, res, io });
    
  } catch (err) {
    console.error('Error extracting data from webhook payload:', err);
    res.status(200).end();
  }
});

router.post("/shopify-webhook/link-opened", async (req,res)=>{
  const { uid } = req.body;
  if (!uid) {
    return res.status(400).json({ error: 'Missing UID parameter' });
  }
  console.log(`Link opened for UID: ${uid}`);
})

const verifyToken = process.env.VERIFY_TOKEN;

router.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

module.exports = router;
