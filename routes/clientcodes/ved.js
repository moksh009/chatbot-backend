const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Client = require('../../models/Client');

// --- CONSTANTS ---
const IMAGES = {
    hero_3mp: 'https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png?v=1760635732&width=1346',
    hero_5mp: 'https://delitechsmarthome.in/cdn/shop/files/my1.png?v=1759746759&width=1346',
    features: 'https://delitechsmarthome.in/cdn/shop/files/1_1.png' // Use a general brand/feature image here
};

const PRODUCTS = {
    '3mp': {
        id: 'prod_3mp',
        name: 'Delitech Doorbell (3MP)',
        price: '₹5,999',
        short_desc: '2K HD Video • Night Vision • 2-Way Talk',
        full_desc: '📹 *3MP 2K HD Video*\n🌙 *Night Vision*\n🗣️ *2-Way Audio*\n🔋 *Wireless Battery*\n🏃 *Motion Detection*',
        img: IMAGES.hero_3mp,
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp'
    },
    '5mp': {
        id: 'prod_5mp',
        name: 'Delitech Pro (5MP)',
        price: '₹6,499',
        short_desc: '5MP Ultra HD • Color Night Vision • AI Detect',
        full_desc: '💎 *5MP Ultra Clarity*\n🌈 *Color Night Vision*\n🤖 *AI Human Detection*\n🚨 *Anti-Theft Siren*\n☁️ *Free Cloud Storage*',
        img: IMAGES.hero_5mp,
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'
    }
};

// --- API WRAPPERS ---

async function sendWhatsAppText({ phoneNumberId, to, body, io }) {
  const token = process.env.WHATSAPP_TOKEN;
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to, type: 'text', text: { body }
    }, { headers: { Authorization: `Bearer ${token}` } });
    await saveAndEmitMessage({ phoneNumberId, to, body, type: 'text', io });
    return true;
  } catch (err) { console.error('Text Error:', err.message); return false; }
}

async function sendWhatsAppInteractive({ phoneNumberId, to, body, interactive, io }) {
  const token = process.env.WHATSAPP_TOKEN;
  const data = { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: interactive.type, body: { text: body }, action: interactive.action } };
  if (interactive.header) data.interactive.header = interactive.header;
  if (interactive.footer) data.interactive.footer = interactive.footer;

  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, data, { headers: { Authorization: `Bearer ${token}` } });
    await saveAndEmitMessage({ phoneNumberId, to, body: `[Interactive] ${body}`, type: 'interactive', io });
    return true;
  } catch (err) { console.error('Interactive Error:', err.message); return false; }
}

async function saveAndEmitMessage({ phoneNumberId, to, body, type, io }) {
    try {
      const client = await Client.findOne({ phoneNumberId });
      const resolvedClientId = client ? client.clientId : 'delitech_smarthomes';
      let conversation = await Conversation.findOne({ phone: to, clientId: resolvedClientId });
      if (!conversation) conversation = await Conversation.create({ phone: to, clientId: resolvedClientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
      
      const savedMessage = await Message.create({ clientId: resolvedClientId, conversationId: conversation._id, from: 'bot', to, content: body, type, direction: 'outgoing', status: 'sent' });
      conversation.lastMessage = body; conversation.lastMessageAt = new Date(); await conversation.save();
      if (io) { io.to(`client_${resolvedClientId}`).emit('new_message', savedMessage); }
    } catch (e) { console.error('DB Error:', e); }
}

async function notifyAdmin({ phoneNumberId, userPhone, type, io }) {
    const adminPhone = process.env.ADMIN_PHONE_NUMBER;
    if (!adminPhone) return;
    await sendWhatsAppText({ phoneNumberId, to: adminPhone, body: `🚨 *Lead Alert: ${type}*\nUser: ${userPhone}`, io });
}

// --- FLOW CONTROLLER ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, io }) {
  const userMsgType = messages.type;
  let userMsg = '';
  let interactiveId = '';

  if (userMsgType === 'text') userMsg = messages.text.body.trim();
  else if (userMsgType === 'interactive') {
      interactiveId = messages.interactive.button_reply?.id || messages.interactive.list_reply?.id;
      userMsg = messages.interactive.button_reply?.title || messages.interactive.list_reply?.title;
  }

  console.log(`User: ${from} | Msg: ${userMsg} | ID: ${interactiveId}`);

  // 1. AD LEAD INTENT (Priority High)
  const adIntentRegex = /(details|know|about|price|info).*product|tell me more/i;
  if (userMsgType === 'text' && adIntentRegex.test(userMsg)) {
      console.log('--- Triggering Ad Flow ---');
      await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp', isAd: true }); // Default to Pro model for ads
      return res.status(200).end();
  }

  // 2. GREETING INTENT
  const greetingRegex = /^(hi|hello|hey|hola|start|menu)/i;
  if (userMsgType === 'text' && greetingRegex.test(userMsg)) {
      await sendMainMenu({ phoneNumberId, to: from, io });
      return res.status(200).end();
  }

  // 3. INTERACTIVE BUTTON HANDLERS
  if (interactiveId) {
      switch (interactiveId) {
          // Main Menu
          case 'menu_products': await sendProductSelection({ phoneNumberId, to: from, io }); break;
          case 'menu_features': await sendFeatureComparison({ phoneNumberId, to: from, io }); break;
          case 'menu_agent': 
              await sendWhatsAppText({ phoneNumberId, to: from, body: "📞 Request received! Our security expert will call you shortly.", io });
              await notifyAdmin({ phoneNumberId, userPhone: from, type: 'Agent Request', io });
              break;

          // Product Selections
          case 'sel_3mp': await sendProductCard({ phoneNumberId, to: from, io, productKey: '3mp' }); break;
          case 'sel_5mp': await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp' }); break;

          // Buy Actions (Workaround for Link Button)
          case 'buy_3mp': await sendPurchaseLink({ phoneNumberId, to: from, io, productKey: '3mp' }); break;
          case 'buy_5mp': await sendPurchaseLink({ phoneNumberId, to: from, io, productKey: '5mp' }); break;

          case 'btn_back_menu': await sendMainMenu({ phoneNumberId, to: from, io }); break;
          
          default: await sendMainMenu({ phoneNumberId, to: from, io });
      }
      return res.status(200).end();
  }

  // 4. FALLBACK
  if (userMsgType === 'text') {
      await sendMainMenu({ phoneNumberId, to: from, io });
  }
  res.status(200).end();
}

// --- TEMPLATES ---

async function sendMainMenu({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: "👋 Welcome to *Delitech Smart Home*!\n\nSecure your home with India's most advanced wireless doorbells. No wiring needed! 🏠✨",
        interactive: {
            type: 'button',
            header: { type: 'text', text: 'Main Menu' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'menu_products', title: '👁 View Products' } },
                    { type: 'reply', reply: { id: 'menu_features', title: '🌟 Why Delitech?' } },
                    { type: 'reply', reply: { id: 'menu_agent', title: '📞 Talk to Human' } }
                ]
            }
        }, io
    });
}

async function sendProductSelection({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: "Select a model to view photos & pricing:",
        interactive: {
            type: 'list',
            header: { type: 'text', text: 'Our Models' },
            action: {
                button: 'Select Doorbell',
                sections: [
                    {
                        title: 'Best Sellers',
                        rows: [
                            { id: 'sel_5mp', title: 'Doorbell Pro (5MP)', description: 'Best Clarity & Color Night Vision' },
                            { id: 'sel_3mp', title: 'Doorbell (3MP)', description: 'High Value 2K HD Video' }
                        ]
                    }
                ]
            }
        }, io
    });
}

async function sendProductCard({ phoneNumberId, to, io, productKey, isAd = false }) {
    const product = PRODUCTS[productKey];
    
    // NOTE: We replaced "Talk to Agent" with "Buy Now" to prioritize sales
    // "Buy Now" triggers a text message with the link because buttons can't have URLs directly
    
    const sent = await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: `🛡️ *${product.name}*\n\n${product.full_desc}\n\n💰 *Offer Price:* ${product.price}\n✅ 1 Year Warranty\n🚚 Free Express Shipping`,
        interactive: {
            type: 'button',
            header: { type: 'image', image: { link: product.img } },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: `buy_${productKey}`, title: '🛒 Buy Now' } }, // Triggers Link Message
                    { type: 'reply', reply: { id: 'menu_products', title: 'View Other Model' } },
                    { type: 'reply', reply: { id: 'menu_agent', title: '📞 Call Me' } }
                ]
            }
        }, io
    });

    if (!sent) {
        // Fallback for failed rich media
        await sendPurchaseLink({ phoneNumberId, to, io, productKey });
    }
}

async function sendPurchaseLink({ phoneNumberId, to, io, productKey }) {
    const product = PRODUCTS[productKey];
    let uid = 'general';
    try {
        const lead = await AdLead.findOneAndUpdate(
            { phoneNumber: to },
            { $setOnInsert: { phoneNumber: to, createdAt: new Date() }, $set: { lastInteraction: new Date() } },
            { upsert: true, new: true }
        );
        if (lead) uid = lead._id;
    } catch(e) {}

    const link = `${product.url}?uid=${uid}`;
    
    // Send the link as a separate text message so it is clickable and generates a preview
    await sendWhatsAppText({ 
        phoneNumberId, 
        to, 
        body: `⚡ *Great Choice!* ⚡\n\nClick the link below to complete your order securely:\n\n👉 ${link}\n\n_Cash on Delivery Available_`, 
        io 
    });
}

async function sendFeatureComparison({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: `🌟 *Why Choose Delitech?*\n\n🔋 *100% Wireless*\nNo wiring headaches. 5 min setup.\n\n🗣️ *2-Way Talk*\nSpeak to visitors from anywhere.\n\n🌙 *Night Vision*\nCrystal clear video in pitch dark.\n\n💾 *Secure Storage*\nSupports SD Card & Cloud.`,
        interactive: {
            type: 'button',
            header: { type: 'image', image: { link: IMAGES.features } }, // Feature Image Added
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'menu_products', title: 'Shop Now' } },
                    { type: 'reply', reply: { id: 'btn_back_menu', title: 'Main Menu' } }
                ]
            }
        }, io
    });
}

// --- ROUTER ---

router.post('/', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = value?.messages?.[0];
    if (!messages) return res.status(200).end();

    let clientId = 'delitech_smarthomes';
    try {
        const client = await Client.findOne({ phoneNumberId: value.metadata.phone_number_id });
        if (client) clientId = client.clientId;
    } catch(e) {}
    const io = req.app.get('socketio');

    let conversation = await Conversation.findOne({ phone: messages.from, clientId });
    if (!conversation) conversation = await Conversation.create({ phone: messages.from, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });

    const userMsgContent = messages.type === 'text' ? messages.text.body : (messages.interactive?.button_reply?.title || messages.interactive?.list_reply?.title || `[${messages.type}]`);

    if (conversation.status === 'HUMAN_TAKEOVER') {
        const savedMsg = await Message.create({ clientId, conversationId: conversation._id, from: messages.from, to: 'bot', content: userMsgContent, type: messages.type, direction: 'incoming', status: 'received' });
        if (io) io.to(`client_${clientId}`).emit('new_message', savedMsg);
        return res.status(200).end();
    }

    await handleUserChatbotFlow({ from: messages.from, phoneNumberId: value.metadata.phone_number_id, messages, res, io });
    
  } catch (err) { console.error('Webhook Error:', err.message); res.status(200).end(); }
});

router.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge']);
  else res.status(403).end();
});

module.exports = router;