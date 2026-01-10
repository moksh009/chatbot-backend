const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
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

    // Save outgoing message to DB and emit socket event
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
        type: 'text',
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
  } catch (err) {
    console.error('Error sending WhatsApp text:', err.response?.data || err.message);
  }
}

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, io }) {
  const userMsgType = messages.type;
  const userMsg = userMsgType === 'text' ? messages.text.body : '';

  // Check for the specific ad message (case insensitive, partial match)
  // "Hey, please give me more details on this product"
  const adMessagePattern = /details on this product/i;

  if (userMsg && adMessagePattern.test(userMsg)) {
    try {
      // 1. Find or Create AdLead
      let lead = await AdLead.findOne({ phoneNumber: from });
      if (!lead) {
        lead = await AdLead.create({ phoneNumber: from });
      }

      // 2. Generate Shopify URL with UID
      // TODO: Update this URL to your actual Shopify product page URL
      const shopifyBaseUrl = 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'; 
      const shopifyUrl = `${shopifyBaseUrl}?uid=${lead._id}`;
      
      const replyBody = `Thanks for your interest! You can view more details and buy the product here: ${shopifyUrl}`;

      await sendWhatsAppText({ phoneNumberId, to: from, body: replyBody, io });
      
    } catch (err) {
      console.error('Error in ad flow:', err);
      await sendWhatsAppText({ phoneNumberId, to: from, body: 'Sorry, something went wrong. Please try again.', io });
    }
  } else {
      // Logic for other messages can be added here.
      // For now, we only handle the ad click flow as requested.
  }
  
  res.status(200).end();
}

router.post('/', async (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  // console.log(JSON.stringify(req.body, null, 2)); // Reduced logging

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
    // (Preserved as requested to keep conversation saving and human AI takeover logic)
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