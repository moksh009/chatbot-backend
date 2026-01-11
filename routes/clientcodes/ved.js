const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Client = require('../../models/Client');
const DailyStat = require('../../models/DailyStat');

// --- 1. ASSETS & DATA (Polished) ---
const IMAGES = {
    hero_3mp: 'https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png?v=1760635732&width=1346',
    hero_5mp: 'https://delitechsmarthome.in/cdn/shop/files/my1.png?v=1759746759&width=1346',
    features: 'https://delitechsmarthome.in/cdn/shop/files/image241.png?v=1762148394&width=1346'
};

const PRODUCTS = {
    '3mp': {
        id: 'prod_3mp',
        name: 'Delitech Doorbell (3MP)',
        price: '₹5,999',
        // Short desc for list view
        short_desc: '2K HD Video • Night Vision • 2-Way Talk',
        // Rich desc for product card
        full_desc: 'The best value smart doorbell in India.\n\n📹 *2K HD Video* (Clear 3MP)\n🌙 *Night Vision* (See in dark)\n🗣️ *2-Way Audio* (Talk to visitors)\n🔋 *Wireless* (Rechargeable Battery)\n🔔 *Free Chime Included*',
        img: IMAGES.hero_3mp,
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp'
    },
    '5mp': {
        id: 'prod_5mp',
        name: 'Delitech Pro (5MP)',
        price: '₹6,499',
        short_desc: '5MP Ultra HD • Color Night Vision • AI Detect',
        full_desc: 'Our most advanced security solution.\n\n💎 *5MP Ultra Clarity* (Best in class)\n🌈 *Color Night Vision*\n🤖 *AI Human Detection* (No false alerts)\n🚨 *Anti-Theft Siren Alarm*\n☁️ *Free Cloud Storage*',
        img: IMAGES.hero_5mp,
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'
    }
};

const FAQS = {
    'install': "*Installation is DIY (Do It Yourself)!* 🛠️\nNo wiring needed. Just stick it or screw it to the wall. Setup takes 5 minutes via our mobile app.",
    'battery': "*Battery Life* 🔋\nThe doorbell lasts 3-6 months on a single charge (depending on usage). Rechargeable via USB cable (included).",
    'warranty': "*Warranty & Support* 🛡️\nWe offer a 1-Year Replacement Warranty on manufacturing defects. Free technical support available."
};

// --- 2. API WRAPPERS ---

async function sendWhatsAppText({ phoneNumberId, to, body, preview_url = false, io }) {
  const token = process.env.WHATSAPP_TOKEN;
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to, type: 'text', text: { body, preview_url }
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

// --- 3. ADVANCED ADMIN NOTIFICATION ---
async function notifyAdmin({ phoneNumberId, userPhone, context, io }) {
    const adminPhone = process.env.ADMIN_PHONE_NUMBER;
    if (!adminPhone) return;

    // Creates a clickable link for the admin to immediately chat with the user
    const leadLink = `https://wa.me/${userPhone}`;
    const alertBody = `🔥 *HOT LEAD ALERT* 🔥\n\n👤 *Customer:* +${userPhone}\n💭 *Interest:* ${context}\n\n👇 *Tap link to chat:* \n${leadLink}`;

    await sendWhatsAppText({ phoneNumberId, to: adminPhone, body: alertBody, preview_url: true, io });
}

// --- 4. FLOW CONTROLLER ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, io, clientId }) {
  const userMsgType = messages.type;
  let userMsg = '';
  let interactiveId = '';

  if (userMsgType === 'text') userMsg = messages.text.body.trim();
  else if (userMsgType === 'interactive') {
      interactiveId = messages.interactive.button_reply?.id || messages.interactive.list_reply?.id;
      userMsg = messages.interactive.button_reply?.title || messages.interactive.list_reply?.title;
  }

  console.log(`User: ${from} | Msg: ${userMsg} | ID: ${interactiveId}`);

  // A. AD LEAD INTENT (Priority)
  // Matches "details on this product", "price", "info", "tell me more"
  const adIntentRegex = /(details|know|about|price|info).*product|tell me more/i;
  
  if (userMsgType === 'text' && adIntentRegex.test(userMsg)) {
      // Direct flow: Show 5MP Pro card immediately
      await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp', isAd: true, clientId });
      return res.status(200).end();
  }

  // B. GREETING INTENT
  const greetingRegex = /^(hi|hello|hey|hola|start|menu)/i;
  if (userMsgType === 'text' && greetingRegex.test(userMsg)) {
      await sendMainMenu({ phoneNumberId, to: from, io });
      return res.status(200).end();
  }

  // C. INTERACTIVE HANDLERS
  if (interactiveId) {
      switch (interactiveId) {
          // --- Navigation ---
          case 'menu_products': await sendProductSelection({ phoneNumberId, to: from, io }); break;
          case 'menu_features': await sendFeatureComparison({ phoneNumberId, to: from, io }); break;
          case 'menu_faqs':     await sendFAQMenu({ phoneNumberId, to: from, io }); break;
          case 'btn_back_menu': await sendMainMenu({ phoneNumberId, to: from, io }); break;
          
          // --- Agent Requests ---
          case 'menu_agent': 
              await handleAgentRequest({ phoneNumberId, to: from, context: 'General Enquiry', io, clientId });
              break;
          case 'agent_5mp':
              await handleAgentRequest({ phoneNumberId, to: from, context: 'Interested in 5MP Pro', io, clientId });
              break;
          case 'agent_3mp':
              await handleAgentRequest({ phoneNumberId, to: from, context: 'Interested in 3MP', io, clientId });
              break;

          // --- Product Selections ---
          case 'sel_3mp': await sendProductCard({ phoneNumberId, to: from, io, productKey: '3mp', clientId }); break;
          case 'sel_5mp': await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp', clientId }); break;

          // --- Buy Actions ---
          case 'buy_3mp': await sendPurchaseLink({ phoneNumberId, to: from, io, productKey: '3mp', clientId }); break;
          case 'buy_5mp': await sendPurchaseLink({ phoneNumberId, to: from, io, productKey: '5mp', clientId }); break;

          // --- FAQs ---
          case 'faq_install': await sendFAQAnswer({ phoneNumberId, to: from, io, key: 'install' }); break;
          case 'faq_battery': await sendFAQAnswer({ phoneNumberId, to: from, io, key: 'battery' }); break;
          case 'faq_warranty': await sendFAQAnswer({ phoneNumberId, to: from, io, key: 'warranty' }); break;
          
          default: await sendMainMenu({ phoneNumberId, to: from, io });
      }
      return res.status(200).end();
  }

  // D. FALLBACK
  if (userMsgType === 'text') {
      await sendMainMenu({ phoneNumberId, to: from, io });
  }
  res.status(200).end();
}

// --- 5. RESPONSE TEMPLATES ---

async function sendMainMenu({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: "👋 Welcome to *Delitech Smart Home*!\n\nSecure your home with India's #1 Wireless Video Doorbell. No wiring, just safety! 🏠✨\n\nChoose an option:",
        interactive: {
            type: 'button',
            header: { type: 'text', text: 'Main Menu' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'menu_products', title: '👁 View Products' } },
                    { type: 'reply', reply: { id: 'menu_features', title: '🌟 Features' } },
                    { type: 'reply', reply: { id: 'menu_faqs', title: '❓ FAQs' } }
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
                            { id: 'sel_3mp', title: 'Doorbell (3MP)', description: 'HD Video, Value Choice' }
                        ]
                    },
                    {
                        title: 'Help',
                        rows: [
                            { id: 'menu_agent', title: 'Talk to Expert', description: 'Get a callback' }
                        ]
                    }
                ]
            }
        }, io
    });
}

async function sendProductCard({ phoneNumberId, to, io, productKey, isAd = false, clientId }) {
    const product = PRODUCTS[productKey];
    
    // We use 3 Buttons: Buy, Call Me, View Other
    const sent = await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: `🛡️ *${product.name}*\n\n${product.full_desc}\n\n💰 *Offer Price:* ${product.price}\n✅ 1 Year Warranty | 🚚 Free Shipping`,
        interactive: {
            type: 'button',
            header: { type: 'image', image: { link: product.img } },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: `buy_${productKey}`, title: '🛒 Buy Now' } },
                    { type: 'reply', reply: { id: `agent_${productKey}`, title: '📞 Call Me' } },
                    { type: 'reply', reply: { id: 'menu_products', title: 'View Other' } }
                ]
            }
        }, io
    });

    // Fallback if image/interactive fails
    if (!sent) {
        await sendPurchaseLink({ phoneNumberId, to, io, productKey, clientId });
    }
}

async function handleAgentRequest({ phoneNumberId, to, context, io, clientId }) {
    // 1. Notify User (Warm, Reassuring)
    await sendWhatsAppText({ 
        phoneNumberId, 
        to, 
        body: `✅ *Request Received!* \n\nOur security expert has been notified. They will call you shortly on this number to assist you with *${context}*.\n\nIn the meantime, feel free to browse our features!`, 
        io 
    });

    // 2. Notify Admin (Actionable)
    await notifyAdmin({ phoneNumberId, userPhone: to, context, io });

    // 3. Track Stat & Emit
    try {
        const today = new Date().toISOString().split('T')[0];
        // Increment daily stats
        await DailyStat.updateOne(
            { clientId, date: today },
            { 
                $inc: { agentRequests: 1 },
                $setOnInsert: { clientId, date: today }
            },
            { upsert: true }
        );
        
        // Emit socket event for real-time dashboard update
        if (io) {
             io.to(`client_${clientId}`).emit('stats_update', { 
                 type: 'agent_request', 
                 phone: to,
                 context
             });
        }
    } catch(e) { console.error('Agent Request Track Error:', e); }
}

async function sendPurchaseLink({ phoneNumberId, to, io, productKey, clientId }) {
    const product = PRODUCTS[productKey];
    
    // 1. Track the Link Click (Purchase Intent) Immediately
    try {
        const lead = await AdLead.findOneAndUpdate(
            { phoneNumber: to, clientId },
            { 
                $inc: { linkClicks: 1 }, 
                $set: { lastInteraction: new Date() },
                $setOnInsert: { 
                    phoneNumber: to, 
                    clientId, 
                    createdAt: new Date(),
                    source: 'WhatsApp'
                }
            },
            { upsert: true, new: true }
        );

        // 2. Emit Real-Time Event to Dashboard
        if (lead && io) {
            io.to(`client_${clientId}`).emit('stats_update', {
                type: 'link_click',
                leadId: lead._id,
                productId: productKey
            });
        }
    } catch(e) { console.error("Lead Tracking Error", e); }

    // 3. Send Direct URL (No Redirects)
    // We append UTM parameters so you can still track source in Shopify Analytics if needed
    const directUrl = product.url; // already contains full path
    const urlObj = new URL(directUrl);
    urlObj.searchParams.set('utm_source', 'whatsapp');
    urlObj.searchParams.set('utm_medium', 'chatbot');
    
    // Send high-converting text message with the direct link
    await sendWhatsAppText({ 
        phoneNumberId, 
        to, 
        body: `⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 ${urlObj.toString()}\n\n_Cash on Delivery Available_`, 
        io 
    });
}

async function sendFeatureComparison({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: `🌟 *Why Choose Delitech?*\n\n🔋 *100% Wireless*\nNo wiring headaches. 5 min setup.\n\n🗣️ *2-Way Talk*\nSpeak to visitors from anywhere.\n\n🌙 *Night Vision*\nCrystal clear video in pitch dark.\n\n💾 *Secure Storage*\nSupports SD Card & Cloud.`,
        interactive: {
            type: 'button',
            header: { type: 'image', image: { link: IMAGES.features } }, // New Feature Image
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'menu_products', title: 'Shop Now' } },
                    { type: 'reply', reply: { id: 'btn_back_menu', title: 'Main Menu' } }
                ]
            }
        }, io
    });
}

async function sendFAQMenu({ phoneNumberId, to, io }) {
    await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: "🤖 *Common Questions*\nSelect a topic to get an instant answer:",
        interactive: {
            type: 'list',
            header: { type: 'text', text: 'FAQs' },
            action: {
                button: 'Select Question',
                sections: [
                    {
                        title: 'Usage',
                        rows: [
                            { id: 'faq_install', title: 'How to install?', description: 'Wiring vs Wireless' },
                            { id: 'faq_battery', title: 'Battery Life', description: 'Charging & Duration' }
                        ]
                    },
                    {
                        title: 'Service',
                        rows: [
                            { id: 'faq_warranty', title: 'Warranty Policy', description: 'Replacement & Repair' },
                            { id: 'menu_agent', title: 'Other Question', description: 'Talk to human' }
                        ]
                    }
                ]
            }
        }, io
    });
}

async function sendFAQAnswer({ phoneNumberId, to, io, key }) {
    await sendWhatsAppText({ phoneNumberId, to, body: FAQS[key], io });
    // Follow up
    await sendWhatsAppInteractive({
        phoneNumberId, to, body: "Does that help?",
        interactive: {
            type: 'button',
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'menu_products', title: 'Yes, Buy Now' } },
                    { type: 'reply', reply: { id: 'menu_agent', title: 'No, Talk to Agent' } }
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

    // --- SAVE INCOMING USER MESSAGE (Fix for Live Chat visibility) ---
    // We save every user message to the database so it appears in the dashboard
    const savedMsg = await Message.create({ 
        clientId, 
        conversationId: conversation._id, 
        from: messages.from, 
        to: 'bot', 
        content: userMsgContent, 
        type: messages.type, 
        direction: 'incoming', 
        status: 'received',
        timestamp: new Date()
    });
    
    // Emit to dashboard immediately
    if (io) io.to(`client_${clientId}`).emit('new_message', savedMsg);

    if (conversation.status === 'HUMAN_TAKEOVER') {
        return res.status(200).end();
    }

    // --- LEAD CAPTURE ---
    try {
        const updatedLead = await AdLead.findOneAndUpdate(
            { phoneNumber: messages.from, clientId },
            { 
                $set: { 
                    lastInteraction: new Date(),
                    chatSummary: userMsgContent.substring(0, 50) 
                },
                $setOnInsert: { 
                    phoneNumber: messages.from, 
                    clientId, 
                    createdAt: new Date(),
                    source: 'WhatsApp'
                }
            },
            { upsert: true, new: true }
        );
        
        if (io) {
            io.to(`client_${clientId}`).emit('stats_update', { 
                type: 'lead_activity', 
                lead: updatedLead 
            });
        }
    } catch (e) { console.error('Lead Capture Error:', e); }

    await handleUserChatbotFlow({ from: messages.from, phoneNumberId: value.metadata.phone_number_id, messages, res, io, clientId });
    
  } catch (err) { console.error('Webhook Error:', err.message); res.status(200).end(); }
});

router.post("/shopify-webhook/link-opened", async (req,res) => { res.status(200).end(); });
router.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge']);
  else res.status(403).end();
});

module.exports = router;