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

// --- HELPERS ---

async function sendWhatsAppText({ phoneNumberId, to, body, io }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  try {
    await axios.post(url, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    await saveAndEmitMessage({ phoneNumberId, to, body, type: 'text', io });
    return true;
  } catch (err) {
    console.error('❌ Text Send Error:', err.response?.data || err.message);
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
    await axios.post(url, data, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    await saveAndEmitMessage({ phoneNumberId, to, body: `[Interactive] ${body}`, type: 'interactive', io });
    return true;
  } catch (err) {
    console.error('❌ Interactive Send Error:', err.response?.data || err.message);
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
    } catch (dbErr) { console.error('DB Error:', dbErr); }
}

async function notifyAdmin({ phoneNumberId, userPhone, userMessage, io }) {
    const adminPhone = process.env.ADMIN_PHONE_NUMBER; 
    if (!adminPhone) return;
    const body = `🚨 *Hot Lead Alert*\nUser: ${userPhone}\nRequest: ${userMessage || 'Agent requested'}`;
    await sendWhatsAppText({ phoneNumberId, to: adminPhone, body, io });
}

// AI Helper
async function getAIResponse(query) {
  try {
    const OpenAI = require('openai');
    if (!process.env.OPENAI_API_KEY) return "I can help you with our products! Check the menu below.";
    
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const kbPath = path.join(__dirname, '../../utils/delitechKnowledgeBase.txt');
    let kbContent = "Delitech Smart Home sells wireless video doorbells (5MP, Night Vision).";
    try { kbContent = fs.readFileSync(kbPath, 'utf8'); } catch (e) {}

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: `You are a sales assistant for Delitech. Short, punchy answers. KB: ${kbContent}` },
        { role: "user", content: query }
      ],
      max_tokens: 100
    });
    return completion.choices[0].message.content;
  } catch (err) {
    return "I can help you with our products! Check the menu below.";
  }
}

// --- CORE FLOW LOGIC ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, io }) {
  const userMsgType = messages.type;
  let userMsg = '';
  let interactiveId = '';

  // Extract Message Content
  if (userMsgType === 'text') {
      userMsg = messages.text.body.trim();
      console.log(`📩 Text from ${from}: "${userMsg}"`);
  } else if (userMsgType === 'interactive') {
      if (messages.interactive.type === 'button_reply') {
          interactiveId = messages.interactive.button_reply.id;
          userMsg = messages.interactive.button_reply.title;
      } else if (messages.interactive.type === 'list_reply') {
          interactiveId = messages.interactive.list_reply.id;
          userMsg = messages.interactive.list_reply.title;
      }
      console.log(`🔘 Button Click from ${from}: ${interactiveId}`);
  }

  // --- 1. PRODUCT AD INTENT (High Priority) ---
  // Matches: "details", "price", "buy", "info", "cost", "more about this"
  const adIntentRegex = /\b(details|info|more|price|cost|buy|interested|product)\b/i;
  
  if (userMsgType === 'text' && adIntentRegex.test(userMsg)) {
      console.log(`🎯 Ad Intent Detected for ${from}`);
      try {
        // Create/Update Lead
        const lead = await AdLead.findOneAndUpdate(
            { phoneNumber: from },
            { $setOnInsert: { phoneNumber: from, createdAt: new Date() }, $set: { lastInteraction: new Date() } },
            { upsert: true, new: true }
        );

        const shopifyBaseUrl = 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'; 
        const trackingUrl = `${shopifyBaseUrl}?uid=${lead._id}`;

        // Send High-Converting Product Card
        // NOTE: URLs cannot be in dynamic buttons. We put it in the body.
        await sendWhatsAppInteractive({
            phoneNumberId,
            to: from,
            body: `🔒 *Delitech Wireless Video Doorbell (5MP)*\n\nUpgrade your home security with crystal clear video, night vision, and 2-way audio.\n\n👇 *Click below to Order Now:*\n${trackingUrl}\n\n_Select an option for more info:_`,
            interactive: {
                type: 'button',
                header: {
                    type: 'image',
                    image: { link: 'https://delitechsmarthome.in/cdn/shop/files/1_1.png' }
                },
                action: {
                    buttons: [
                        { type: 'reply', reply: { id: 'btn_features', title: '✨ Features' } },
                        { type: 'reply', reply: { id: 'btn_reviews', title: '⭐ Reviews' } },
                        { type: 'reply', reply: { id: 'btn_products', title: '🏠 More Items' } }
                    ]
                }
            },
            io
        });
      } catch (err) {
          console.error('Ad Flow Error:', err);
          await sendMainMenu({ phoneNumberId, to: from, io });
      }
      return res.status(200).end();
  }

  // --- 2. GREETING FLOW ---
  const greetingPattern = /^(hi|hello|hey|hola|start|menu)/i;
  if (userMsgType === 'text' && greetingPattern.test(userMsg)) {
      await sendMainMenu({ phoneNumberId, to: from, io });
      return res.status(200).end();
  }

  // --- 3. BUTTON & LIST HANDLERS ---
  if (interactiveId) {
      switch (interactiveId) {
          case 'btn_products':
              await sendProductList({ phoneNumberId, to: from, io });
              break;
          case 'btn_track_order':
              await sendWhatsAppText({ phoneNumberId, to: from, body: "📦 To track your order, please reply with your *Order ID* (e.g., #1234) or email address used during purchase.", io });
              break;
          case 'btn_support':
          case 'btn_agent':
              await sendWhatsAppText({ phoneNumberId, to: from, body: "👩‍💼 connecting you to a support agent... We will reply shortly!", io });
              await notifyAdmin({ phoneNumberId, userPhone: from, userMessage: "Customer requested support", io });
              break;
          case 'btn_features':
              await sendFeatures({ phoneNumberId, to: from, io });
              break;
          case 'btn_reviews':
              await sendWhatsAppText({ phoneNumberId, to: from, body: "⭐⭐⭐⭐⭐\n*Rahul S.*: \"Excellent quality, easy to install.\"\n\n⭐⭐⭐⭐⭐\n*Priya M.*: \"Night vision is amazing. Highly recommend!\"", io });
              await sendWhatsAppInteractive({
                  phoneNumberId, to: from,
                  body: "Ready to buy?",
                  interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'product_1', title: '🛒 Buy Now' } }] } }, io
              });
              break;
          case 'product_1': // Doorbell
               await sendProductDetail({ 
                   phoneNumberId, to: from, io, 
                   name: 'Wireless Video Doorbell 5MP',
                   price: '₹2,499',
                   img: 'https://delitechsmarthome.in/cdn/shop/files/1_1.png',
                   url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'
               });
               break;
          case 'product_2': // Chime
               await sendProductDetail({ 
                   phoneNumberId, to: from, io, 
                   name: 'Indoor Chime',
                   price: '₹899',
                   img: 'https://delitechsmarthome.in/cdn/shop/files/chime.png',
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

  // --- 4. AI / CATCH-ALL ---
  if (userMsgType === 'text') {
      const aiReply = await getAIResponse(userMsg);
      await sendWhatsAppText({ phoneNumberId, to: from, body: aiReply, io });
      
      // If AI is unsure, show menu
      if (aiReply.length < 20 || aiReply.includes("menu")) {
          setTimeout(() => sendMainMenu({ phoneNumberId, to: from, io }), 1000);
      }
  }

  res.status(200).end();
}

// --- MESSAGE TEMPLATES ---

async function sendMainMenu({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: "👋 Welcome to *Delitech Smart Home*!\nYour partner in home security.\n\nSelect an option below:",
        interactive: {
            type: 'list',
            header: { type: 'text', text: 'Main Menu' },
            action: {
                button: 'Open Menu',
                sections: [
                    {
                        title: 'Shopping',
                        rows: [
                            { id: 'btn_products', title: '🏠 View Products', description: 'Cameras, Doorbells & More' },
                            { id: 'btn_track_order', title: '📦 Track Order', description: 'Check shipment status' }
                        ]
                    },
                    {
                        title: 'Support',
                        rows: [
                            { id: 'btn_support', title: '📞 Talk to Agent', description: 'Get human assistance' }
                        ]
                    }
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
        body: "🛡️ *Secure your home today!*\nChoose a product to view details & price:",
        interactive: {
            type: 'button',
            header: { type: 'text', text: 'Best Sellers' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'product_1', title: '📹 Video Doorbell' } },
                    { type: 'reply', reply: { id: 'product_2', title: '🔔 Indoor Chime' } },
                    { type: 'reply', reply: { id: 'btn_main_menu', title: '🔙 Main Menu' } }
                ]
            }
        },
        io
    });
}

async function sendProductDetail({ phoneNumberId, to, io, name, price, img, url }) {
    const lead = await AdLead.findOne({ phoneNumber: to });
    const uid = lead ? lead._id : 'gen';
    const finalUrl = `${url}?uid=${uid}`;

    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: `*${name}*\nPrice: *${price}*\n\n✅ 5MP HD Video\n✅ Night Vision\n✅ Wireless Setup\n\n👇 *Click link to buy:*\n${finalUrl}`,
        interactive: {
            type: 'button',
            header: { type: 'image', image: { link: img } },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'btn_features', title: '🔍 Full Specs' } },
                    { type: 'reply', reply: { id: 'btn_products', title: '🔙 All Products' } }
                ]
            }
        },
        io
    });
}

async function sendFeatures({ phoneNumberId, to, io }) {
    const body = `📋 *Technical Specifications*\n\n- *Resolution:* 5 Megapixel HD\n- *Audio:* 2-Way Talk (Noise Cancellation)\n- *Power:* Rechargeable Battery (3-6 months)\n- *Connectivity:* WiFi 2.4GHz\n- *Storage:* Cloud + SD Card Support`;
    
    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body,
        interactive: {
            type: 'button',
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'product_1', title: '🛒 Buy Now' } },
                    { type: 'reply', reply: { id: 'btn_agent', title: '📞 Ask Question' } }
                ]
            }
        },
        io
    });
}

// --- ROUTER BOILERPLATE ---

router.post('/', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const messages = value?.messages?.[0];
    const from = messages?.from;

    if (!messages || !from) return res.status(200).end();

    // Init DB & Socket
    let clientId = 'delitech_smarthomes';
    try {
        const client = await Client.findOne({ phoneNumberId });
        if (client) clientId = client.clientId;
    } catch(e) {}
    const io = req.app.get('socketio');

    let conversation = await Conversation.findOne({ phone: from, clientId });
    if (!conversation) {
      conversation = await Conversation.create({ phone: from, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
    }

    const userMsgContent = messages.type === 'text' ? messages.text.body : 
                           messages.type === 'interactive' ? (messages.interactive.button_reply?.title || messages.interactive.list_reply?.title) : `[${messages.type}]`;

    // Check Human Takeover
    if (conversation.status === 'HUMAN_TAKEOVER') {
        const savedMsg = await Message.create({ clientId, conversationId: conversation._id, from, to: 'bot', content: userMsgContent, type: messages.type, direction: 'incoming', status: 'received' });
        if (io) { io.to(`client_${clientId}`).emit('new_message', savedMsg); }
        return res.status(200).end();
    }

    // Process Bot Flow
    await handleUserChatbotFlow({ from, phoneNumberId, messages, res, io });
    
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(200).end();
  }
});

router.post("/shopify-webhook/link-opened", async (req,res) => { res.status(200).end(); });
router.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else { res.status(403).end(); }
});

module.exports = router;