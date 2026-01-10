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

// --- HELPERS (Now returning Success/Fail status) ---

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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    await saveAndEmitMessage({ phoneNumberId, to, body, type: 'text', io });
    return true;
  } catch (err) {
    console.error('Error sending WhatsApp text:', err.response?.data || err.message);
    return false;
  }
}

async function sendWhatsAppImage({ phoneNumberId, to, imageUrl, caption, io }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link: imageUrl, caption: caption || '' }
  };
  try {
    await axios.post(url, data, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    await saveAndEmitMessage({ phoneNumberId, to, body: `[Image] ${caption}`, type: 'image', io });
    return true;
  } catch (err) {
    console.error('Error sending WhatsApp image:', err.response?.data || err.message);
    return false;
  }
}

async function sendWhatsAppInteractive({ phoneNumberId, to, body, interactive, io }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
        type: interactive.type,
        body: { text: body },
        action: interactive.action
    }
  };
  
  if (interactive.header) data.interactive.header = interactive.header;
  if (interactive.footer) data.interactive.footer = interactive.footer;

  try {
    await axios.post(url, data, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    await saveAndEmitMessage({ phoneNumberId, to, body: `[Interactive] ${body}`, type: 'interactive', io });
    return true;
  } catch (err) {
    console.error('Error sending WhatsApp interactive:', err.response?.data || err.message);
    return false;
  }
}

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
    const OpenAI = require('openai');
    if (!process.env.OPENAI_API_KEY) {
        return "I am currently unable to access my AI brain. Please use the menu below!";
    }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const kbPath = path.join(__dirname, '../../utils/delitechKnowledgeBase.txt');
    let kbContent = "Delitech Smart Home sells wireless video doorbells with 5MP cameras.";
    try { kbContent = fs.readFileSync(kbPath, 'utf8'); } catch (e) {}

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: `You are a helpful AI for Delitech Smart Home. Knowledge Base:\n${kbContent}` },
        { role: "user", content: query }
      ],
      max_tokens: 150
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error('AI Error:', err.message);
    if (err.status === 429) return "I am currently experiencing high traffic. Please browse our products below.";
    return "I apologize, I'm having trouble processing that request. Please select an option from the menu.";
  }
}

async function notifyAdmin({ phoneNumberId, userPhone, userMessage, io }) {
    const adminPhone = process.env.ADMIN_PHONE_NUMBER; 
    if (!adminPhone) return;
    const body = `🚨 *New Agent Request*\nUser: ${userPhone}\nMessage: ${userMessage || 'Requested agent.'}`;
    await sendWhatsAppText({ phoneNumberId, to: adminPhone, body, io });
}

// --- MAIN LOGIC ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, io }) {
  const userMsgType = messages.type;
  let userMsg = '';
  let interactiveId = '';

  if (userMsgType === 'text') {
      userMsg = messages.text.body;
      console.log(`📩 Received TEXT from ${from}: "${userMsg}"`);
  } else if (userMsgType === 'interactive') {
      if (messages.interactive.type === 'button_reply') {
          interactiveId = messages.interactive.button_reply.id;
          userMsg = messages.interactive.button_reply.title;
      } else if (messages.interactive.type === 'list_reply') {
          interactiveId = messages.interactive.list_reply.id;
          userMsg = messages.interactive.list_reply.title;
      }
      console.log(`📩 Received INTERACTIVE from ${from}: ID="${interactiveId}" Title="${userMsg}"`);
  }

  // 1. AD TRIGGER FLOW
  // Matches "details on this product", "know details on product", "want details", etc.
  const adMessagePattern = /(details|know).*product/i; 
  if (userMsgType === 'text' && adMessagePattern.test(userMsg)) {
      console.log(`🎯 Triggering AD FLOW for ${from}`);
      try {
        // Use findOneAndUpdate with upsert to prevent "Duplicate Key" errors
        const lead = await AdLead.findOneAndUpdate(
            { phoneNumber: from },
            { $setOnInsert: { phoneNumber: from, createdAt: new Date() } },
            { upsert: true, new: true }
        );

        const shopifyBaseUrl = 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'; 
        const shopifyUrl = `${shopifyBaseUrl}?uid=${lead._id}`;

        // Send Text-Only Message as requested for stability
        await sendWhatsAppInteractive({
            phoneNumberId,
            to: from,
            body: `Welcome to Delitech Smart Home! 🏠\n\nHere is the Wireless Video Doorbell you are interested in.\n\n🛒 *Buy Now*: ${shopifyUrl}`,
            interactive: {
                type: 'button',
                // Header removed for stability as per user request
                // header: {
                //     type: 'image',
                //     image: { link: 'https://delitechsmarthome.in/cdn/shop/files/1_1.png' }
                // },
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
          console.error('❌ Error in ad flow:', err);
          await sendMainMenu({ phoneNumberId, to: from, io });
      }
      return res.status(200).end();
  }

  // 2. GREETING FLOW
  const greetingPattern = /^(hi|hello|hey|hola)/i;
  if (userMsgType === 'text' && greetingPattern.test(userMsg)) {
      console.log(`👋 Triggering GREETING FLOW for ${from}`);
      await sendMainMenu({ phoneNumberId, to: from, io });
      return res.status(200).end();
  }

  // 3. INTERACTIVE HANDLERS
  if (interactiveId) {
      switch (interactiveId) {
          case 'btn_products':
              await sendProductList({ phoneNumberId, to: from, io });
              break;
          case 'btn_faqs':
              await sendWhatsAppText({ phoneNumberId, to: from, body: "🤖 *Ask me anything!*\n\nType questions like 'How to install?' or 'Is it waterproof?'.", io });
              break;
          case 'btn_features':
              await sendFeatures({ phoneNumberId, to: from, io });
              break;
          case 'btn_agent':
              await sendWhatsAppText({ phoneNumberId, to: from, body: "📞 Connecting you to an agent... An admin has been notified.", io });
              await notifyAdmin({ phoneNumberId, userPhone: from, userMessage: "User requested agent via menu", io });
              break;
          case 'product_1':
               await sendProductDetail({ 
                   phoneNumberId, to: from, io, 
                   name: 'Wireless Video Doorbell 5MP',
                   img: 'https://delitechsmarthome.in/cdn/shop/files/1_1.png',
                   url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'
               });
               break;
          case 'product_2':
               await sendProductDetail({ 
                   phoneNumberId, to: from, io, 
                   name: 'Indoor Chime',
                   img: 'https://delitechsmarthome.in/cdn/shop/files/chime.png', // Ensure this image exists!
                   url: 'https://delitechsmarthome.in/products/indoor-chime'
               });
               break;
          case 'btn_main_menu':
               await sendMainMenu({ phoneNumberId, to: from, io });
               break;
          default:
               await sendMainMenu({ phoneNumberId, to: from, io });
      }
      return res.status(200).end();
  }

  // 4. AI FALLBACK
  if (userMsgType === 'text') {
      console.log(`🧠 Calling AI for: "${userMsg}"`);
      const aiReply = await getAIResponse(userMsg);
      console.log(`🤖 AI Reply: "${aiReply}"`);
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
                            { id: 'product_1', title: 'Video Doorbell 5MP', description: 'Wireless, HD Camera' },
                            { id: 'product_2', title: 'Indoor Chime', description: 'Loud ringer for doorbell' }
                        ]
                    },
                    {
                        title: 'Info',
                        rows: [
                            { id: 'btn_features', title: 'Doorbell Features', description: 'Detailed specs' }
                        ]
                    }
                ]
            }
        },
        io
    });
}

async function sendProductDetail({ phoneNumberId, to, io, name, img, url }) {
    const lead = await AdLead.findOne({ phoneNumber: to });
    const uid = lead ? lead._id : 'general';
    const finalUrl = `${url}?uid=${uid}`;

    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: `*${name}*\n\nTop quality smart home security.\n\n🛒 *Buy Now*: ${finalUrl}`,
        interactive: {
            type: 'button',
            header: { type: 'image', image: { link: img } },
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
    const features = `🌟 *Delitech Video Doorbell Features* 🌟\n\n✅ *5MP HD Video*\n✅ *Two-Way Audio*\n✅ *Night Vision*\n✅ *Motion Detection*\n✅ *Wireless / Battery*\n✅ *Weatherproof*`;
    await sendWhatsAppText({ phoneNumberId, to, body: features, io });
    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: "Ready to secure your home?",
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

// --- ROUTER & WEBHOOK ---

router.post('/', async (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\nWebhook received ${timestamp}`);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const messages = value?.messages?.[0];
    const from = messages?.from;

    if (!messages || !from) return res.status(200).end();

    // --- DB & SOCKET LOGIC ---
    let clientId = 'delitech_smarthomes';
    try {
        if (phoneNumberId) {
            const client = await Client.findOne({ phoneNumberId });
            if (client) clientId = client.clientId;
        }
    } catch(e) {}
    const io = req.app.get('socketio');

    let conversation = await Conversation.findOne({ phone: from, clientId });
    if (!conversation) {
      conversation = await Conversation.create({ phone: from, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
    }

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

    conversation.lastMessage = userMsgContent;
    conversation.lastMessageAt = new Date();
    if (conversation.status === 'HUMAN_TAKEOVER') conversation.unreadCount += 1;
    await conversation.save();

    if (io) {
      io.to(`client_${clientId}`).emit('new_message', savedMsg);
      io.to(`client_${clientId}`).emit('conversation_update', conversation);
    }

    if (conversation.status === 'HUMAN_TAKEOVER') return res.status(200).end();

    // Trigger Flow
    await handleUserChatbotFlow({ from, phoneNumberId, messages, res, io });
    
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(200).end();
  }
});

router.post("/shopify-webhook/link-opened", async (req,res) => {
  const { uid } = req.body;
  if (uid) console.log(`Link opened for UID: ${uid}`);
  res.status(200).end();
});

router.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

module.exports = router;