const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Client = require('../../models/Client');

// --- CONSTANTS (Hardcoded from Website) ---
const PRODUCTS = {
    '3mp': {
        id: 'prod_3mp',
        name: 'Delitech Wireless Doorbell (3MP)',
        price: '₹5,999',
        desc: '3MP 2K HD Video, 130° Wide View, Night Vision, 2-Way Audio, Motion Detection. Includes Chime.',
        img: 'https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png?v=1760635732&width=1346', // Ensure this is a valid public image URL
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp'
    },
    '5mp': {
        id: 'prod_5mp',
        name: 'Delitech Doorbell Pro (5MP)',
        price: '₹6,499',
        desc: 'Ultra HD 5MP, Color Night Vision, Advanced AI Detection, Anti-Theft Siren. Best Clarity.',
        img: 'https://delitechsmarthome.in/cdn/shop/files/my1.png?v=1759746759&width=1346', // Update if there is a specific 5MP image
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'
    }
};

// --- HELPERS ---

async function sendWhatsAppText({ phoneNumberId, to, body, io }) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
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
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  
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
    const body = `🚨 *Agent Request*\nUser: ${userPhone}`;
    await sendWhatsAppText({ phoneNumberId, to: adminPhone, body, io });
}

// --- NEW FLOW LOGIC ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, io }) {
  const userMsgType = messages.type;
  let userMsg = '';
  let interactiveId = '';

  // 1. Extract Content
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
      console.log(`🔘 Selection from ${from}: ${interactiveId}`);
  }

  // 2. AD LEAD INTENT (Priority High)
  // Catches: "details on this product", "tell me about this", "price of this"
  const adIntentRegex = /(details|know|about|price|info).*product/i;
  
  if (userMsgType === 'text' && adIntentRegex.test(userMsg)) {
      console.log(`🎯 Ad Lead Detected: ${from}`);
      try {
          // Send the 5MP Pro Model by default for ads
          await sendProductCard({ 
              phoneNumberId, to: from, io, 
              productKey: '5mp', 
              isAd: true 
          });
      } catch (e) {
          console.error("Ad Flow Error", e);
          await sendMainMenu({ phoneNumberId, to: from, io });
      }
      return res.status(200).end();
  }

  // 3. GREETING INTENT
  const greetingRegex = /^(hi|hello|hey|hola|start|menu)/i;
  if (userMsgType === 'text' && greetingRegex.test(userMsg)) {
      await sendMainMenu({ phoneNumberId, to: from, io });
      return res.status(200).end();
  }

  // 4. MENU & BUTTON HANDLERS
  if (interactiveId) {
      switch (interactiveId) {
          // --- Main Menu Options ---
          case 'menu_products':
              await sendProductSelection({ phoneNumberId, to: from, io });
              break;
          case 'menu_pricing':
              await sendPricingTable({ phoneNumberId, to: from, io });
              break;
          case 'menu_features':
              await sendFeatureComparison({ phoneNumberId, to: from, io });
              break;
          case 'menu_agent':
              await sendWhatsAppText({ phoneNumberId, to: from, body: "👩‍💼 Connecting you to an expert agent... Please wait.", io });
              await notifyAdmin({ phoneNumberId, userPhone: from, userMessage: "Menu Agent Request", io });
              break;

          // --- Product Selections ---
          case 'sel_3mp':
              await sendProductCard({ phoneNumberId, to: from, io, productKey: '3mp' });
              break;
          case 'sel_5mp':
              await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp' });
              break;

          // --- Navigation ---
          case 'btn_back_menu':
              await sendMainMenu({ phoneNumberId, to: from, io });
              break;
          
          default:
              await sendMainMenu({ phoneNumberId, to: from, io });
      }
      return res.status(200).end();
  }

  // 5. FALLBACK (If text doesn't match greeting/ad)
  if (userMsgType === 'text') {
      // Simple logic since OpenAI is down
      await sendMainMenu({ phoneNumberId, to: from, io });
  }

  res.status(200).end();
}

// --- RESPONSE TEMPLATES ---

async function sendMainMenu({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: "👋 Welcome to *Delitech Smart Home*!\nIndia's #1 Wireless Video Doorbell Brand.\n\nHow can we secure your home today?",
        interactive: {
            type: 'button',
            header: { type: 'text', text: 'Main Menu' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'menu_products', title: '👁 View Products' } },
                    { type: 'reply', reply: { id: 'menu_features', title: '✨ Features' } },
                    { type: 'reply', reply: { id: 'menu_agent', title: '📞 Talk to Agent' } }
                ]
            }
        },
        io
    });
}

async function sendProductSelection({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: "Select a model to see details & photos:",
        interactive: {
            type: 'list',
            header: { type: 'text', text: 'Our Models' },
            action: {
                button: 'Select Model',
                sections: [
                    {
                        title: 'Video Doorbells',
                        rows: [
                            { id: 'sel_5mp', title: 'Doorbell Pro (5MP)', description: 'Best Clarity, Color Night Vision' },
                            { id: 'sel_3mp', title: 'Doorbell (3MP)', description: 'HD Video, Value Choice' }
                        ]
                    }
                ]
            }
        },
        io
    });
}

async function sendProductCard({ phoneNumberId, to, io, productKey, isAd = false }) {
    console.log(`🛍️ Sending Product Card (${productKey}) to ${to}`);
    // 1. Get Product Data
    const product = PRODUCTS[productKey];
    if (!product) {
        console.error(`❌ Product key '${productKey}' not found!`);
        return;
    }
    
    // 2. Track Lead (Get UID)
    let uid = 'general';
    try {
        const lead = await AdLead.findOneAndUpdate(
            { phoneNumber: to },
            { $setOnInsert: { phoneNumber: to, createdAt: new Date() }, $set: { lastInteraction: new Date() } },
            { upsert: true, new: true }
        );
        if (lead) uid = lead._id;
    } catch (e) {
        console.error("⚠️ Lead Tracking Error:", e.message);
    }
    
    // 3. Construct Tracking URL
    const trackingUrl = `${product.url}?uid=${uid}`;

    // 4. Construct Message Body
    // NOTE: WhatsApp does not allow URLs in buttons. We put it BOLD in the body.
    let bodyText = `🛡️ *${product.name}*\n\n`;
    bodyText += `${product.desc}\n\n`;
    bodyText += `💰 *Price:* ${product.price}\n`;
    bodyText += `✅ *1 Year Warranty* | 🚚 *Free Shipping*\n\n`;
    bodyText += `👇 *CLICK LINK TO BUY NOW:*\n${trackingUrl}`;

    // 5. Send Interactive Message with Image Header
    const sent = await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: bodyText,
        interactive: {
            type: 'button',
            header: {
                type: 'image',
                image: { link: product.img }
            },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'menu_products', title: 'View Other Models' } },
                    { type: 'reply', reply: { id: 'menu_agent', title: 'Talk to Agent' } }
                ]
            }
        },
        io
    });

    // Fallback if interactive fails (often due to image issues)
    if (!sent) {
        console.log("⚠️ Interactive failed, sending text fallback.");
        await sendWhatsAppText({ phoneNumberId, to, body: bodyText, io });
        await sendWhatsAppInteractive({
            phoneNumberId, to, body: "Select an option:",
            interactive: {
                type: 'button',
                action: { buttons: [{ type: 'reply', reply: { id: 'menu_products', title: 'View Other Models' } }] }
            }, io
        });
    }
}

async function sendFeatureComparison({ phoneNumberId, to, io }) {
    const text = `🌟 *Why Choose Delitech?*\n\n` +
                 `🔋 *100% Wireless:* Runs on rechargeable battery (up to 6 months).\n` +
                 `🗣️ *2-Way Talk:* Speak to visitors from your phone.\n` +
                 `🌙 *Night Vision:* See clearly in total darkness.\n` +
                 `🚶 *Motion Alerts:* Instant notification when someone is near.\n` +
                 `💾 *Storage:* Cloud + SD Card Support.`;
    
    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: text,
        interactive: {
            type: 'button',
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'menu_products', title: 'See Models' } },
                    { type: 'reply', reply: { id: 'menu_pricing', title: 'Check Pricing' } }
                ]
            }
        },
        io
    });
}

async function sendPricingTable({ phoneNumberId, to, io }) {
    const text = `💰 *Current Pricing*\n\n` +
                 `1️⃣ *3MP Model:* ₹5,999\n(HD Video, Standard Night Vision)\n\n` +
                 `2️⃣ *5MP Pro Model:* ₹6,499\n(Ultra HD, Color Night Vision)\n\n` +
                 `_Prices include GST & Shipping._`;

    await sendWhatsAppInteractive({
        phoneNumberId,
        to,
        body: text,
        interactive: {
            type: 'button',
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'sel_5mp', title: 'Buy 5MP Pro' } },
                    { type: 'reply', reply: { id: 'sel_3mp', title: 'Buy 3MP' } },
                    { type: 'reply', reply: { id: 'btn_back_menu', title: 'Main Menu' } }
                ]
            }
        },
        io
    });
}

// --- ROUTER SETUP ---

router.post('/', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const messages = value?.messages?.[0];
    const from = messages?.from;

    if (!messages || !from) return res.status(200).end();

    // Database & Socket Init
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

    // Save Incoming Message
    const userMsgContent = messages.type === 'text' ? messages.text.body : 
                           messages.type === 'interactive' ? (messages.interactive.button_reply?.title || messages.interactive.list_reply?.title) : `[${messages.type}]`;

    // Human Takeover Check
    if (conversation.status === 'HUMAN_TAKEOVER') {
        const savedMsg = await Message.create({ clientId, conversationId: conversation._id, from, to: 'bot', content: userMsgContent, type: messages.type, direction: 'incoming', status: 'received' });
        if (io) { io.to(`client_${clientId}`).emit('new_message', savedMsg); }
        return res.status(200).end();
    }

    // Trigger Bot Flow
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