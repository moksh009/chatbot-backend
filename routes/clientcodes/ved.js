const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Client = require('../../models/Client');
const DailyStat = require('../../models/DailyStat');
const Order = require('../../models/Order');

// --- 1. ASSETS & DATA (Polished) ---
const IMAGES = {
    hero_3mp: 'https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png?v=1760635732&width=1346',
    hero_5mp: 'https://delitechsmarthome.in/cdn/shop/files/my1.png?v=1759746759&width=1346',
    features: 'https://delitechsmarthome.in/cdn/shop/files/image241.png?v=1762148394&width=1346'
};

const PRODUCTS = {
    '2mp': {
        id: 'prod_2mp',
        name: 'Delitech Smart Wireless Video Doorbell (2MP)',
        price: '₹5,499',
        short_desc: '1080p HD Video • Night Vision • 2-Way Talk',
        full_desc: 'The best value smart doorbell in India.\n\n📹 *1080p HD Video*\n🌙 *Night Vision* (See in dark)\n🗣️ *2-Way Audio* (Talk to visitors)\n🔋 *Wireless* (Rechargeable Battery)\n🔔 *Free Installation*',
        img: IMAGES.hero_3mp, // reuse 3mp image or generic
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-2mp'
    },
    '3mp': {
        id: 'prod_3mp',
        name: 'Delitech Smart Wireless Video Doorbell Plus (3MP)',
        price: '₹5,999',
        short_desc: '2K HD Video • Night Vision • 2-Way Talk',
        full_desc: 'Enhanced clarity smart doorbell.\n\n📹 *2K HD Video* (Clear 3MP)\n🌙 *Night Vision* (See in dark)\n🗣️ *2-Way Audio* (Talk to visitors)\n🔋 *Wireless* (Rechargeable Battery)\n🔔 *Free Installation*',
        img: IMAGES.hero_3mp,
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp'
    },
    '5mp': {
        id: 'prod_5mp',
        name: 'Delitech Smart Wireless Video Doorbell Pro (5MP)',
        price: '₹6,999',
        short_desc: '5MP Ultra HD • Color Night Vision • AI Detect',
        full_desc: 'Our most advanced security solution.\n\n💎 *5MP Ultra Clarity* (Best in class)\n🌈 *Color Night Vision*\n🤖 *AI Human Detection* (No false alerts)\n🚨 *Anti-Theft Siren Alarm*\n💾 *Free SD Card + Free Installation*',
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

async function sendWhatsAppText({ phoneNumberId, to, body, preview_url = false, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body, preview_url }
        }, { headers: { Authorization: `Bearer ${token}` } });
        await saveAndEmitMessage({ phoneNumberId, to, body, type: 'text', io, clientConfig });
        return true;
    } catch (err) { console.error('Text Error:', err.message); return false; }
}

async function sendWhatsAppInteractive({ phoneNumberId, to, body, interactive, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    const data = { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: interactive.type, body: { text: body }, action: interactive.action } };
    if (interactive.header) data.interactive.header = interactive.header;
    if (interactive.footer) data.interactive.footer = interactive.footer;

    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, data, { headers: { Authorization: `Bearer ${token}` } });
        await saveAndEmitMessage({
            phoneNumberId,
            to,
            body: `[Interactive] ${body}`,
            type: 'interactive',
            io,
            clientConfig,
            metadata: { interactive }
        });
        return true;
    } catch (err) {
        // Detailed error logging for debugging 401
        if (err.response) {
            console.error(`Interactive Error: Status ${err.response.status}`);
            console.error(`Data:`, JSON.stringify(err.response.data, null, 2));
        } else {
            console.error('Interactive Error:', err.message);
        }
        return false;
    }
}

async function saveAndEmitMessage({ phoneNumberId, to, body, type, io, clientConfig, metadata }) {
    try {
        const resolvedClientId = clientConfig.clientId;
        let conversation = await Conversation.findOne({ phone: to, clientId: resolvedClientId });
        if (!conversation) conversation = await Conversation.create({ phone: to, clientId: resolvedClientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });

        const savedMessage = await Message.create({
            clientId: resolvedClientId,
            conversationId: conversation._id,
            from: 'bot',
            to,
            content: body,
            type,
            direction: 'outgoing',
            status: 'sent',
            metadata
        });
        conversation.lastMessage = body; conversation.lastMessageAt = new Date(); await conversation.save();
        if (io) { io.to(`client_${resolvedClientId}`).emit('new_message', savedMessage); }
    } catch (e) { console.error('DB Error:', e); }
}

// --- 3. ADVANCED ADMIN NOTIFICATION ---
async function notifyAdmin({ phoneNumberId, userPhone, context, io, clientConfig }) {
    const adminPhone = clientConfig.adminPhoneNumber;
    if (!adminPhone) return;

    // Creates a clickable link for the admin to immediately chat with the user
    const leadLink = `https://wa.me/${userPhone}`;
    const alertBody = `🔥 *HOT LEAD ALERT* 🔥\n\n👤 *Customer:* +${userPhone}\n💭 *Interest:* ${context}\n\n👇 *Tap link to chat:* \n${leadLink}`;

    await sendWhatsAppText({ phoneNumberId, to: adminPhone, body: alertBody, preview_url: true, io, clientConfig });
}

// --- 4. FLOW CONTROLLER ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, io, clientConfig }) {
    const userMsgType = messages.type;
    let userMsg = '';
    let interactiveId = '';

    if (userMsgType === 'text') userMsg = messages.text.body.trim();
    else if (userMsgType === 'interactive') {
        interactiveId = messages.interactive.button_reply?.id || messages.interactive.list_reply?.id;
        userMsg = messages.interactive.button_reply?.title || messages.interactive.list_reply?.title;
    }

    console.log(`User: ${from} | Msg: ${userMsg} | ID: ${interactiveId}`);

    const normalizedMsg = userMsg.toLowerCase();

    if (userMsgType === 'text') {
        if (normalizedMsg.includes('5mp doorbell details') || normalizedMsg.includes('5mp doorbell') || normalizedMsg.includes('5mp details')) {
            await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp', isAd: true, clientConfig });
            return res.status(200).end();
        }
        if (normalizedMsg.includes('3mp doorbell details') || normalizedMsg.includes('3mp doorbell') || normalizedMsg.includes('3mp details')) {
            await sendProductCard({ phoneNumberId, to: from, io, productKey: '3mp', isAd: true, clientConfig });
            return res.status(200).end();
        }
        if (normalizedMsg.includes('2mp doorbell details') || normalizedMsg.includes('2mp doorbell') || normalizedMsg.includes('2mp details')) {
            await sendProductCard({ phoneNumberId, to: from, io, productKey: '2mp', isAd: true, clientConfig });
            return res.status(200).end();
        }
        if (normalizedMsg.includes('want to know more')) {
            await sendMainMenu({ phoneNumberId, to: from, io, clientConfig });
            return res.status(200).end();
        }
    }

    // A. AD LEAD INTENT (Priority)
    // Matches "details on this product", "price", "info", "tell me more"
    const adIntentRegex = /(details|know|about|price|info).*product|tell me more/i;

    if (userMsgType === 'text' && adIntentRegex.test(userMsg)) {
        // Direct flow: Show 5MP Pro card immediately
        await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp', isAd: true, clientConfig });
        return res.status(200).end();
    }

    // B. GREETING INTENT
    const greetingRegex = /^(hi|hello|hey|hola|start|menu)/i;
    if (userMsgType === 'text' && greetingRegex.test(userMsg)) {
        await sendMainMenu({ phoneNumberId, to: from, io, clientConfig });
        return res.status(200).end();
    }

    // C. INTERACTIVE HANDLERS
    if (interactiveId) {
        switch (interactiveId) {
            // --- Navigation ---
            case 'menu_products': await sendProductSelection({ phoneNumberId, to: from, io, clientConfig }); break;
            case 'menu_features': await sendFeatureComparison({ phoneNumberId, to: from, io, clientConfig }); break;
            case 'menu_faqs': await sendFAQMenu({ phoneNumberId, to: from, io, clientConfig }); break;
            case 'btn_back_menu': await sendMainMenu({ phoneNumberId, to: from, io, clientConfig }); break;

            // --- Agent Requests ---
            case 'menu_agent':
                await handleAgentRequest({ phoneNumberId, to: from, context: 'General Enquiry', io, clientConfig });
                break;
            case 'agent_5mp':
                await handleAgentRequest({ phoneNumberId, to: from, context: 'Interested in 5MP Pro', io, clientConfig });
                break;
            case 'agent_3mp':
                await handleAgentRequest({ phoneNumberId, to: from, context: 'Interested in 3MP Plus', io, clientConfig });
                break;
            case 'agent_2mp':
                await handleAgentRequest({ phoneNumberId, to: from, context: 'Interested in 2MP', io, clientConfig });
                break;

            // --- Product Selections ---
            case 'sel_2mp': await sendProductCard({ phoneNumberId, to: from, io, productKey: '2mp', clientConfig }); break;
            case 'sel_3mp': await sendProductCard({ phoneNumberId, to: from, io, productKey: '3mp', clientConfig }); break;
            case 'sel_5mp': await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp', clientConfig }); break;

            // --- Buy Actions ---
            case 'buy_2mp': await sendPurchaseLink({ phoneNumberId, to: from, io, productKey: '2mp', clientConfig }); break;
            case 'buy_3mp': await sendPurchaseLink({ phoneNumberId, to: from, io, productKey: '3mp', clientConfig }); break;
            case 'buy_5mp': await sendPurchaseLink({ phoneNumberId, to: from, io, productKey: '5mp', clientConfig }); break;

            // --- FAQs ---
            case 'faq_install': await sendFAQAnswer({ phoneNumberId, to: from, io, key: 'install', clientConfig }); break;
            case 'faq_battery': await sendFAQAnswer({ phoneNumberId, to: from, io, key: 'battery', clientConfig }); break;
            case 'faq_warranty': await sendFAQAnswer({ phoneNumberId, to: from, io, key: 'warranty', clientConfig }); break;

            default: await sendMainMenu({ phoneNumberId, to: from, io, clientConfig });
        }
        return res.status(200).end();
    }

    // D. FALLBACK
    if (userMsgType === 'text') {
        await sendMainMenu({ phoneNumberId, to: from, io, clientConfig });
    }
    res.status(200).end();
}

// --- 5. RESPONSE TEMPLATES ---

async function sendMainMenu({ phoneNumberId, to, io, clientConfig }) {
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
        }, io, clientConfig
    });
}

async function sendProductSelection({ phoneNumberId, to, io, clientConfig }) {
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
                            { id: 'sel_3mp', title: 'Doorbell Plus (3MP)', description: 'Enhanced HD Video, Plus Features' },
                            { id: 'sel_2mp', title: 'Doorbell (2MP)', description: 'Standard HD Video, Value Choice' }
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
        }, io, clientConfig
    });
}

async function sendProductCard({ phoneNumberId, to, io, productKey, isAd = false, clientConfig }) {
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
        }, io, clientConfig
    });

    // Fallback if image/interactive fails
    if (!sent) {
        await sendPurchaseLink({ phoneNumberId, to, io, productKey, clientConfig });
    }
}

async function handleAgentRequest({ phoneNumberId, to, context, io, clientConfig }) {
    // 1. Notify User (Warm, Reassuring)
    await sendWhatsAppText({
        phoneNumberId,
        to,
        body: `✅ *Request Received!* \n\nOur security expert has been notified. They will call you shortly on this number to assist you with *${context}*.\n\nIn the meantime, feel free to browse our features!`,
        io,
        clientConfig
    });

    // 2. Notify Admin (Actionable)
    await notifyAdmin({ phoneNumberId, userPhone: to, context, io, clientConfig });

    // 3. Track Stat & Emit
    try {
        const today = new Date().toISOString().split('T')[0];
        // Increment daily stats
        await DailyStat.updateOne(
            { clientId: clientConfig.clientId, date: today },
            {
                $inc: { agentRequests: 1 },
                $setOnInsert: { clientId: clientConfig.clientId, date: today }
            },
            { upsert: true }
        );

        // Emit socket event for real-time dashboard update
        if (io) {
            io.to(`client_${clientConfig.clientId}`).emit('stats_update', {
                type: 'agent_request',
                phone: to,
                context
            });
        }
    } catch (e) { console.error('Agent Request Track Error:', e); }
}

async function sendPurchaseLink({ phoneNumberId, to, io, productKey, clientConfig }) {
    const product = PRODUCTS[productKey];

    // 1. Track the Link Click (Purchase Intent) Immediately
    var leadid = "";
    try {
        const lead = await AdLead.findOneAndUpdate(
            { phoneNumber: to, clientId: clientConfig.clientId },
            {
                $inc: { linkClicks: 1 },
                $set: { lastInteraction: new Date() },
                $push: {
                    activityLog: {
                        action: 'whatsapp_restore_link_clicked',
                        details: `Requested link for ${productKey}`,
                        timestamp: new Date(),
                        meta: {}
                    }
                },
                $setOnInsert: {
                    phoneNumber: to,
                    clientId: clientConfig.clientId,
                    createdAt: new Date(),
                    source: 'WhatsApp'
                }
            },
            { upsert: true, new: true }
        );

        // 2. Emit Real-Time Event to Dashboard
        if (lead && io) {
            leadid = lead._id.toString();
            io.to(`client_${clientConfig.clientId}`).emit('stats_update', {
                type: 'link_click',
                leadId: lead._id,
                productId: productKey
            });
        }
    } catch (e) { console.error("Lead Tracking Error", e); }

    // 3. Send Direct URL (No Redirects)
    // We append UTM parameters so you can still track source in Shopify Analytics if needed
    const directUrl = product.url;
    const urlObj = new URL(directUrl);
    urlObj.searchParams.set('utm_source', 'whatsapp');
    urlObj.searchParams.set('utm_medium', 'chatbot');
    urlObj.searchParams.set('uid', leadid);

    // Send high-converting text message with the direct link
    await sendWhatsAppText({
        phoneNumberId,
        to,
        body: `⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 ${urlObj.toString()}\n\n_Cash on Delivery Available_`,
        io,
        clientConfig
    });
}

async function sendFeatureComparison({ phoneNumberId, to, io, clientConfig }) {
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
        }, io, clientConfig
    });
}

async function sendFAQMenu({ phoneNumberId, to, io, clientConfig }) {
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
        }, io, clientConfig
    });
}

async function sendFAQAnswer({ phoneNumberId, to, io, key, clientConfig }) {
    await sendWhatsAppText({ phoneNumberId, to, body: FAQS[key], io, clientConfig });
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
        }, io, clientConfig
    });
}

// --- ROUTER REPLACEMENT ---

const handleWebhook = async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const value = entry?.changes?.[0]?.value;
        const messages = value?.messages?.[0];
        if (!messages) return res.status(200).end();

        const clientConfig = req.clientConfig;
        const clientId = clientConfig.clientId;
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

        await handleUserChatbotFlow({ from: messages.from, phoneNumberId: value.metadata.phone_number_id, messages, res, io, clientConfig });

    } catch (err) { console.error('Webhook Error:', err.message); res.status(200).end(); }
};

const handleShopifyLinkOpenedWebhook = async (req, res) => {
    try {
        const { uid, page } = req.body;
        const io = req.app.get('socketio');

        if (!uid) {
            console.warn("uid_missing: Shopify link open received without uid");
            return res.status(200).end();
        }

        const now = new Date();
        const updatedLead = await AdLead.findOneAndUpdate(
            { _id: uid },
            {
                $inc: { linkClicks: 1 },
                $set: { lastInteraction: now },
                $push: {
                    activityLog: {
                        action: 'whatsapp_restore_link_clicked',
                        details: `clicked link | page: ${page || 'storefront'}`,
                        timestamp: now,
                        meta: {}
                    }
                }
            },
            { new: true }
        );

        if (updatedLead && io) {
            io.to(`client_${updatedLead.clientId}`).emit('stats_update', {
                type: 'link_click',
                leadId: updatedLead._id
            });
        }

        return res.status(200).end();
    } catch (error) {
        console.error("Shopify link open tracking error:", error);
        return res.status(200).end();
    }
};

const handleShopifyCartUpdatedWebhook = async (req, res) => {
    try {
        const { uid, cartitems, product_titles, page, items, phone } = req.body;
        const clientConfig = req.clientConfig;
        const io = req.app.get('socketio');

        let lead = null;
        if (uid) {
            lead = await AdLead.findById(uid);
        } else if (phone) {
            // Fallback: match by phone if uid is missing from tracking pixel
            let cleanPhone = phone.replace(/\D/g, '');
            if (cleanPhone.length > 10 && cleanPhone.startsWith('91')) cleanPhone = cleanPhone.substring(2);
            lead = await AdLead.findOne({ phoneNumber: { $regex: new RegExp(`${cleanPhone}$`) }, clientId: clientConfig.clientId });
        }

        if (!lead) {
            console.log("Shopify cart update: lead not found for uid/phone:", uid, phone);
            return res.status(200).end();
        }

        const newHandles = Array.isArray(cartitems) ? cartitems : [];
        const newTitles = Array.isArray(product_titles) ? product_titles : [];
        const cartItemsArray = Array.isArray(items) && items.length > 0
            ? items.map(i => ({
                variant_id: String(i.variant_id || i.id),
                quantity: Number(i.quantity),
                image: i.image || i.featured_image?.url || '',
                url: i.url || ''
            }))
            : newHandles.map(id => ({ variant_id: String(id), quantity: 1 }));
        const now = new Date();

        const prevHandles = Array.isArray(lead.cartSnapshot?.handles) ? lead.cartSnapshot.handles : [];
        const prevTitles = Array.isArray(lead.cartSnapshot?.titles) ? lead.cartSnapshot.titles : [];

        const prevMap = {};
        prevHandles.forEach((h, idx) => {
            prevMap[h] = prevTitles[idx] || h;
        });

        const newMap = {};
        newHandles.forEach((h, idx) => {
            newMap[h] = newTitles[idx] || h;
        });

        const added = newHandles.filter(h => !prevHandles.includes(h));
        const removed = prevHandles.filter(h => !newHandles.includes(h));

        console.log("Shopify cart update for lead phone number:", lead.phoneNumber);
        console.log("Cart handles:", newHandles);

        const activityEntries = [];

        if (['purchased', 'abandoned', 'recovered'].includes(lead.cartStatus)) {
            activityEntries.push({
                action: 'new_cart_session_started',
                details: 'Cart lifecycle reset after previous purchase/abandonment',
                timestamp: now,
                meta: {}
            });
        }

        activityEntries.push({
            action: 'cart_updated',
            details: `cart updated | items: ${(newTitles.length ? newTitles : newHandles).join(', ')} | page: ${page || '/cart'}`,
            timestamp: now,
            meta: {}
        });

        const addCountIncrement = added.length > 0 ? 1 : 0;

        const update = {
            $set: {
                cartStatus: 'active',
                lastInteraction: now,
                cartSnapshot: {
                    handles: newHandles,
                    titles: newTitles.length === newHandles.length ? newTitles : newHandles,
                    items: cartItemsArray,
                    updatedAt: now
                }
            }
        };

        if (['purchased', 'abandoned', 'recovered'].includes(lead.cartStatus)) {
            update.$unset = {
                abandonedCartReminderSentAt: "",
                abandonedCartRecoveredAt: ""
            };
            update.$set.adminFollowUpTriggered = false;
            update.$set.checkoutInitiatedCount = 0;
        }

        if (addCountIncrement > 0) {
            update.$inc = { addToCartCount: addCountIncrement };
        }

        if (activityEntries.length) {
            update.$push = {
                activityLog: {
                    $each: activityEntries
                }
            };
        }

        const updatedLead = await AdLead.findOneAndUpdate(
            { _id: uid },
            update,
            { new: true }
        );

        if (updatedLead && io) {
            io.to(`client_${updatedLead.clientId}`).emit('stats_update', {
                type: 'add_to_cart',
                leadId: updatedLead._id,
                cartitems: newHandles,
                product_titles: newTitles
            });
        }

        if (clientConfig && clientConfig.phoneNumberId && added.length) {
            const context = `Added to cart: ${added.map(h => newMap[h]).join(', ')} | page: ${page || '/cart'}`;
            try {
                await notifyAdmin({
                    phoneNumberId: clientConfig.phoneNumberId,
                    userPhone: lead.phoneNumber,
                    context,
                    io,
                    clientConfig
                });
            } catch (e) {
                console.error("Cart admin notify error:", e);
            }
        }

        return res.status(200).end();
    } catch (error) {
        console.error("Shopify cart update error:", error);
        return res.status(200).end();
    }
};

const handleShopifyCheckoutInitiatedWebhook = async (req, res) => {
    try {
        const { uid, cartitems, product_titles, total_price, page, phone } = req.body;
        const clientConfig = req.clientConfig;
        const io = req.app.get('socketio');

        let lead = null;
        if (uid) {
            lead = await AdLead.findById(uid);
        } else if (phone) {
            // Fallback: match by phone if uid is missing from frontend tracking
            let cleanPhone = phone.replace(/\D/g, '');
            if (cleanPhone.length > 10 && cleanPhone.startsWith('91')) cleanPhone = cleanPhone.substring(2);
            lead = await AdLead.findOne({ phoneNumber: { $regex: new RegExp(`${cleanPhone}$`) }, clientId: clientConfig.clientId });
        }

        if (!lead) {
            console.log("Shopify checkout initiated: lead not found for uid/phone:", uid, phone);
            return res.status(200).end();
        }

        const newHandles = Array.isArray(cartitems) ? cartitems : [];
        const newTitles = Array.isArray(product_titles) ? product_titles : [];
        const now = new Date();
        const priceFormatted = total_price ? (total_price / 100).toLocaleString() : '0';

        console.log("Shopify checkout initiated for lead phone number:", lead.phoneNumber);

        const activityEntries = [{
            action: 'checkout_initiated',
            details: `Checkout initiated | items: ${(newTitles.length ? newTitles : newHandles).join(', ')} | total: ₹${priceFormatted} | page: ${page || '/cart'}`,
            timestamp: now,
            meta: {}
        }];

        if (lead.cartStatus === 'recovered') {
            activityEntries.push({
                action: 'checkout_started_after_recovery',
                details: 'User initiated checkout after recovering abandoned cart via WhatsApp',
                timestamp: now,
                meta: {}
            });
        }

        const update = {
            $set: {
                lastInteraction: now,
                cartSnapshot: {
                    handles: newHandles,
                    titles: newTitles.length === newHandles.length ? newTitles : newHandles,
                    updatedAt: now
                }
            },
            $inc: { checkoutInitiatedCount: 1 },
            $push: {
                activityLog: { $each: activityEntries }
            }
        };

        const updatedLead = await AdLead.findOneAndUpdate(
            { _id: uid },
            update,
            { new: true }
        );

        if (updatedLead && io) {
            io.to(`client_${updatedLead.clientId}`).emit('stats_update', {
                type: 'checkout_initiated',
                leadId: updatedLead._id,
                cartitems: newHandles,
                product_titles: newTitles,
                total_price: priceFormatted
            });
        }

        if (clientConfig && clientConfig.phoneNumberId && newHandles.length) {
            const context = `Checkout initiated for: ${(newTitles.length ? newTitles : newHandles).join(', ')} | value: ₹${priceFormatted}`;
            try {
                await notifyAdmin({
                    phoneNumberId: clientConfig.phoneNumberId,
                    userPhone: lead.phoneNumber,
                    context,
                    io,
                    clientConfig
                });
            } catch (e) {
                console.error("Checkout initiated admin notify error:", e);
            }
        }

        return res.status(200).end();
    } catch (error) {
        console.error("Shopify checkout initiated error:", error);
        return res.status(200).end();
    }
};

const handleShopifyOrderCompleteWebhook = async (req, res) => {
    try {
        const payload = req.body;
        const clientConfig = req.clientConfig;
        const io = req.app.get('socketio');

        // Shopify sends 'total_price', 'customer', 'line_items', 'name' (orderId), 'shipping_address', 'payment_gateway_names'
        const orderId = payload.name || `#${payload.order_number}`;
        const totalPrice = parseFloat(payload.total_price) || 0;
        const customer = payload.customer || {};
        const shipping = payload.shipping_address || {};

        // Extract payment method
        let paymentMethod = payload.gateway || '';
        if (payload.payment_gateway_names && payload.payment_gateway_names.length > 0) {
            paymentMethod = payload.payment_gateway_names.join(', ');
        }

        // Clean phone number (Shopify usually sends +91... or similar)
        let phone = customer.phone || payload.phone || shipping.phone || payload.billing_address?.phone || '';
        phone = phone.replace(/\D/g, '');
        if (phone.length > 10 && phone.startsWith('91')) phone = phone.substring(2);

        const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Valued Customer';
        const lineItems = payload.line_items || [];

        const items = lineItems.map(item => ({
            name: item.title,
            quantity: item.quantity,
            price: parseFloat(item.price) || 0
        }));

        const itemNames = items.map(i => `${i.quantity}x ${i.name}`).join(', ');

        console.log(`Shopify order complete received: ${orderId} for phone: ${phone}`);

        // 1. Create or Update Order in DB
        const newOrder = await Order.findOneAndUpdate(
            { orderId, clientId: clientConfig.clientId },
            {
                $set: {
                    customerName,
                    phone,
                    amount: totalPrice,
                    status: 'paid', // Shopify orders are usually paid if this webhook fires
                    items,
                    paymentMethod,
                    address: `${shipping.address1 || ''} ${shipping.address2 || ''}`.trim() || 'N/A',
                    city: shipping.city || '',
                    state: shipping.province || '',
                    zip: shipping.zip || ''
                },
                $setOnInsert: {
                    clientId: clientConfig.clientId,
                    createdAt: new Date()
                }
            },
            { upsert: true, new: true }
        );

        // 2. Update AdLead if it exists
        let leadId = null;
        if (phone) {
            const existingLead = await AdLead.findOne({ phoneNumber: { $regex: new RegExp(`${phone}$`) }, clientId: clientConfig.clientId });

            if (existingLead) {
                const activityEntries = [{
                    action: 'order_placed',
                    details: `Order ${orderId} placed | value: ₹${totalPrice} | items: ${itemNames}`,
                    timestamp: new Date(),
                    meta: {}
                }];

                if (existingLead.cartStatus === 'recovered') {
                    activityEntries.push({
                        action: 'purchase_completed_after_recovery',
                        details: `Order ${orderId} placed after recovering cart`,
                        timestamp: new Date(),
                        meta: {}
                    });
                }

                const incObj = { totalSpent: totalPrice, ordersCount: 1 };
                // Patch UI funnel logic for users who used Express "Buy Now" checkout bypassing cart events
                if (!existingLead.addToCartCount) incObj.addToCartCount = 1;
                if (!existingLead.checkoutInitiatedCount) incObj.checkoutInitiatedCount = 1;

                const updateObj = {
                    $set: { isOrderPlaced: true, lastInteraction: new Date(), cartStatus: 'purchased' },
                    $inc: incObj,
                    $push: {
                        activityLog: { $each: activityEntries }
                    }
                };

                const updatedLead = await AdLead.findByIdAndUpdate(existingLead._id, updateObj, { new: true });
                if (updatedLead) leadId = updatedLead._id;
            }
        }

        // 3. Emit Socket Event for real-time dashboard
        if (io) {
            io.to(`client_${clientConfig.clientId}`).emit('new_order', newOrder);
            if (leadId) {
                io.to(`client_${clientConfig.clientId}`).emit('stats_update', {
                    type: 'order_placed',
                    leadId: leadId,
                    orderId: newOrder.orderId,
                    amount: totalPrice
                });
            }
        }

        // 4. Notify Admin on WhatsApp
        if (clientConfig && clientConfig.phoneNumberId) {
            const addressString = shipping.address1 ? `${shipping.address1}, ${shipping.city || ''}` : 'No address provided';
            const alertBody = `🎉 *NEW ORDER RECEIVED!* 🎉\n\n🆔 *Order:* ${orderId}\n👤 *Customer:* ${customerName}\n📱 *Phone:* +91${phone}\n💰 *Value:* ₹${totalPrice.toLocaleString()}\n💳 *Payment:* ${paymentMethod || 'N/A'}\n📍 *Address:* ${addressString}\n\n📦 *Items:*\n${itemNames}`;

            // Send Admin Notification
            try {
                const adminPhone = clientConfig.adminPhoneNumber;
                if (adminPhone) {
                    await sendWhatsAppText({ phoneNumberId: clientConfig.phoneNumberId, to: adminPhone, body: alertBody, io, clientConfig });
                }
            } catch (e) {
                console.error("Order admin notify error:", e.response?.data || e.message);
            }

            // 5. Notify Customer on WhatsApp
            try {
                if (phone) {
                    const customerMessage = `🎉 *Thank You for Your Order!* 🎉\n\nHi ${customerName},\nYour order ${orderId} has been successfully placed safely. We will notify you once it's shipped!\n\nQuestions? Just reply to this message.`;
                    await sendWhatsAppText({ phoneNumberId: clientConfig.phoneNumberId, to: phone, body: customerMessage, io, clientConfig });
                }
            } catch (e) {
                console.error("Order customer notify error:", e.response?.data || e.message);
            }
        }

        return res.status(200).end();
    } catch (error) {
        console.error("Shopify order complete error:", error);
        return res.status(200).end();
    }
};

const getClientOrders = async (req, res) => {
    try {
        const clientConfig = req.clientConfig;
        const orders = await Order.find({ clientId: clientConfig.clientId }).sort({ createdAt: -1 }).limit(100);
        res.json(orders);
    } catch (error) {
        console.error("Fetch orders error:", error);
        res.status(500).json({ error: 'Server configuration error' });
    }
};

const getCartSnapshot = async (req, res) => {
    try {
        const { uid } = req.query;

        if (!uid) {
            return res.status(400).json({ success: false, message: 'UID missing' });
        }

        let leadData = null;
        if (uid && /^[0-9a-fA-F]{24}$/.test(uid)) {
            try {
                leadData = await AdLead.findById(uid);
            } catch (e) {
                console.log("Invalid ObjectId lookup failed silently");
            }
        }

        if (!leadData) {
            leadData = await AdLead.findOne({ phoneNumber: uid }).catch(() => null); // fallback just in case
        }

        if (!leadData || !leadData.cartSnapshot) {
            return res.status(404).json({ success: false, message: 'Cart not found' });
        }

        res.json({
            success: true,
            cart: leadData.cartSnapshot
        });
    } catch (err) {
        console.error("Cart snapshot fetch error:", err);
        res.status(500).json({ success: false });
    }
};

const restoreCart = async (req, res) => {
    try {
        const { uid } = req.query;

        if (!uid) {
            return res.status(400).send('UID missing');
        }

        let lead = null;
        if (uid.length === 24) {
            lead = await AdLead.findById(uid);
        }

        if (!lead) {
            return res.status(404).send('Cart not found');
        }

        // Idempotency check to prevent duplicate restores/logs
        if (lead.cartStatus === 'recovered' || lead.cartStatus === 'purchased') {
            return res.redirect(`https://delitechsmarthome.in/cart?uid=${uid}&restore=true`);
        }

        // Mark cartStatus -> recovered
        // Set abandonedCartRecoveredAt
        // Log activity

        await AdLead.findByIdAndUpdate(lead._id, {
            $set: {
                cartStatus: 'recovered',
                abandonedCartRecoveredAt: new Date()
            },
            $push: {
                activityLog: [
                    {
                        action: 'whatsapp_restore_link_clicked',
                        details: 'User clicked restore cart link from WhatsApp',
                        timestamp: new Date()
                    },
                    {
                        action: 'cart_restored',
                        details: 'Cart restoration process initiated',
                        timestamp: new Date()
                    }
                ]
            }
        });

        res.redirect(`https://delitechsmarthome.in/cart?uid=${uid}&restore=true`);
    } catch (error) {
        console.error("Restore cart error:", error);
        res.status(500).send('An error occurred while restoring the cart');
    }
};

const logRestoreEvent = async (req, res) => {
    try {
        const { uid, action, details } = req.body;
        if (!uid) {
            console.warn("uid_missing: logRestoreEvent without uid");
            return res.status(400).end();
        }

        let lead = null;
        if (uid.length === 24) {
            lead = await AdLead.findById(uid);
        }
        if (!lead) {
            return res.status(404).end();
        }

        await AdLead.findByIdAndUpdate(lead._id, {
            $push: {
                activityLog: {
                    action: action || 'restore_failed',
                    details: details || 'Unknown error during cart restoration',
                    timestamp: new Date(),
                    meta: {}
                }
            }
        });

        res.status(200).json({ success: true });
    } catch (err) {
        console.error("logRestoreEvent error:", err);
        res.status(500).end();
    }
};

module.exports = {
    handleWebhook,
    handleShopifyLinkOpenedWebhook,
    handleShopifyCartUpdatedWebhook,
    handleShopifyCheckoutInitiatedWebhook,
    handleShopifyOrderCompleteWebhook,
    getClientOrders,
    getCartSnapshot,
    restoreCart,
    logRestoreEvent
};
