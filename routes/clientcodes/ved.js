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
    hero_2mp: 'https://delitechsmarthome.in/cdn/shop/files/DelitechMainphotos7i.png?v=1770617818&width=1346',
    features: 'https://delitechsmarthome.in/cdn/shop/files/image241.png?v=1762148394&width=1346'
};

const PRODUCTS = {
    '2mp': {
        id: 'prod_2mp',
        name: 'Delitech Smart Video Doorbell (2MP)',
        price: '₹5,499',
        short_desc: 'Standard HD Video • 2-Way Talk',
        full_desc: 'Essential home security made simple.\n\n📹 *1080p HD Video*\n🌙 *Night Vision* (Clear up to 15ft)\n🗣️ *2-Way Audio* (Talk from your phone)\n🔋 *100% Wireless* (No drilling required)\n🔔 *Free Chime Included*\n\n🎁 *SPECIAL OFFER:* Free Shipping + Free Installation',
        img: IMAGES.hero_2mp,
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-2mp'
    },
    '3mp': {
        id: 'prod_mp',
        name: 'Delitech Smart Video Doorbell Plus (3MP)',
        price: '₹6,499',
        short_desc: '2K Crisp Video • Color Night Vision',
        full_desc: 'The perfect balance of affordability and HD security.\n\n📹 *2048×1536 (3MP) HD Video*\n🌈 *Color Night Vision*\n🗣️ *Real-Time 2-Way Audio*\n🔋 *100% Wireless Setup*\n🔔 *Instant Phone Alerts*\n\n🎁 *SPECIAL OFFER:* Free Shipping + Free Installation',
        img: IMAGES.hero_3mp,
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp'
    },
    '5mp': {
        id: 'prod_5mp',
        name: 'Delitech Smart Video Doorbell Pro (5MP)',
        price: '₹6,999',
        short_desc: '5MP Ultra HD • Smart AI • Anti-Theft',
        full_desc: 'The ultimate peace-of-mind solution. Unmatched clarity and premium security.\n\n💎 *5MP Crystal-Clear Resolution*\n👀 *Ultra-Wide 130° Head-to-Toe View*\n🌈 *Color Night Vision*\n🤖 *AI Smart Visitor Log* (No false alerts)\n🚨 *Built-in Anti-Theft Siren*\n🌦️ *IP65 Weatherproof* (Rain/Heat resistant)\n💾 *Free SD Card Included*\n\n🎁 *SPECIAL OFFER:* Free Shipping + Free Installation',
        img: IMAGES.hero_5mp,
        url: 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'
    }
};

const FAQS = {
    'install': "🛠️ *Is it hard to install?*\nNot at all! It's *100% Wireless DIY*. No electricians or wiring needed. You can stick it or screw it to the wall in under 2 minutes. Setup through the CloudEdge App is instant.",
    'battery': "🔋 *How long does the battery last?*\nThe IP65 weatherproof battery lasts *up to 6 months* on a single charge (depending on motion alerts). Simply recharge it via the included USB cable.",
    'warranty': "🛡️ *What about Warranty & Support?*\nEnjoy complete peace of mind with our *1-Year Replacement Warranty* on any manufacturing defects, plus free premium technical support."
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

async function sendWhatsAppImage({ phoneNumberId, to, imageUrl, caption, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            to,
            type: 'image',
            image: {
                link: imageUrl,
                caption: caption
            }
        }, { headers: { Authorization: `Bearer ${token}` } });

        // Log it to the conversation as well
        await saveAndEmitMessage({ phoneNumberId, to, body: `[Image Sent] ${caption}`, type: 'image', io, clientConfig });
        return true;
    } catch (e) {
        console.error('sendWhatsAppImage Error:', e.response?.data || e.message);
        return false;
    }
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

async function sendWhatsAppTemplate({ phoneNumberId, to, templateName, headerImage, buttonUrlParam, bodyVariables = [], languageCode = 'en', io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    try {
        const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
        const components = [];
        if (headerImage) {
            components.push({
                type: 'header',
                parameters: [
                    {
                        type: 'image',
                        image: { link: headerImage }
                    }
                ]
            });
        }

        if (bodyVariables && bodyVariables.length > 0) {
            components.push({
                type: 'body',
                parameters: bodyVariables.map(val => ({ type: 'text', text: String(val) }))
            });
        }

        if (buttonUrlParam) {
            components.push({
                type: 'button',
                sub_type: 'url',
                index: 0,
                parameters: [
                    {
                        type: 'text',
                        text: buttonUrlParam
                    }
                ]
            });
        }

        const data = {
            messaging_product: 'whatsapp',
            to: to,
            type: 'template',
            template: {
                name: templateName,
                language: {
                    code: languageCode
                },
                components: components
            }
        };

        const response = await axios.post(url, data, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });

        // saveAndEmitMessage is removed as per instruction, assuming it's handled by the caller or not needed for templates
        return response.data;
    } catch (error) {
        console.error(`Template Error (${templateName}):`, error.response?.data || error.message);
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

async function logActivity(leadId, action, details) {
    try {
        await AdLead.findByIdAndUpdate(leadId, {
            $push: {
                activityLog: {
                    action,
                    details,
                    timestamp: new Date()
                }
            }
        });
    } catch (err) {
        console.error("Activity log error:", err);
    }
}


// --- 3. ADVANCED ADMIN NOTIFICATION ---
async function notifyAdmin({ phoneNumberId, userPhone, context, io, clientConfig }) {
    const adminPhone = '919313045439'; // Hardcoded as per request
    if (!adminPhone) return;

    // Always send a plain text message so admin is always notified reliably
    const leadLink = `https://wa.me/${userPhone}`;
    const alertBody = `🚨 *HOT LEAD*\n*Customer Phone:* +${userPhone}\n💭 *User Action:* ${context}\n\n👇 *Tap the link below to chat with them immediately:*\n${leadLink}\n\nTry to close the sale while they are still online!`;

    await sendWhatsAppText({ phoneNumberId, to: adminPhone, body: alertBody, preview_url: true, io, clientConfig });
}

// --- 4. FLOW CONTROLLER ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, io, clientConfig, lead }) {
    // Ensure lead exists for logging/context
    if (!lead) {
        console.warn(`[Flow] No lead provided for ${from}, attempting lookup...`);
        lead = await AdLead.findOne({ phoneNumber: from, clientId: clientConfig.clientId });
    }

    const userMsgType = messages.type;
    let userMsg = '';
    let interactiveId = '';

    if (userMsgType === 'text') userMsg = messages.text.body.trim();
    else if (userMsgType === 'interactive') {
        interactiveId = messages.interactive.button_reply?.id || messages.interactive.list_reply?.id;
        userMsg = messages.interactive.button_reply?.title || messages.interactive.list_reply?.title;
    } else if (userMsgType === 'button') {
        // Handle Template Quick Replies (type: button)
        userMsg = messages.button?.text || "";
        interactiveId = messages.button?.payload || "";
    }

    console.log(`User: ${from} | Msg: ${userMsg} | ID: ${interactiveId}`);

    const normalizedMsg = userMsg.toLowerCase();

    if (userMsgType === 'text') {
        const txt = normalizedMsg;

        // --- DIRECT FEATURE/OBJECTION MATCHING ---
        if (txt.includes('waterproof') || txt.includes('rain') || txt.includes('weather')) {
            await sendWhatsAppInteractive({
                phoneNumberId, to: from, io, clientConfig,
                body: "🌦️ *IP65 Weatherproof Guarantee*\n\nYes! Our Doorbells are built to withstand the heaviest Indian monsoons and intense summer heat. You never have to worry about water damage.\n\nReady to secure your home?",
                interactive: {
                    type: 'button',
                    action: { buttons: [{ type: 'reply', reply: { id: 'buy_5mp', title: 'Get 5MP Pro' } }, { type: 'reply', reply: { id: 'menu_products', title: 'View All' } }] }
                }
            });
            return res.status(200).end();
        }

        if (txt.includes('wire') || txt.includes('drill') || txt.includes('install')) {
            await sendWhatsAppInteractive({
                phoneNumberId, to: from, io, clientConfig,
                body: "⚡ *100% Wireless DIY Setup*\n\nNo drilling, no electricians, and no messy wires! Installation takes exactly 2 minutes. You can screw it in or use the heavy-duty adhesive.\n\nWhich model are you looking for?",
                interactive: {
                    type: 'button',
                    action: { buttons: [{ type: 'reply', reply: { id: 'menu_products', title: 'View Doorbells' } }, { type: 'reply', reply: { id: 'buy_5mp', title: 'Buy 5MP Pro' } }] }
                }
            });
            return res.status(200).end();
        }

        if (txt.includes('battery') || txt.includes('charge')) {
            await sendWhatsAppInteractive({
                phoneNumberId, to: from, io, clientConfig,
                body: "🔋 *Massive 6-Month Battery*\n\nDelitech Doorbells run on an ultra-capacity rechargeable battery that lasts up to 6 months on a single charge! Just plug it in overnight when low.",
                interactive: {
                    type: 'button',
                    action: { buttons: [{ type: 'reply', reply: { id: 'menu_products', title: 'View Doorbells' } }] }
                }
            });
            return res.status(200).end();
        }

        // --- DIRECT PRODUCT MATCHING ---
        if (txt.includes('5mp') || txt.includes('pro')) {
            await logActivity(lead._id, 'viewed_product', '5mp');
            const sent = await sendWhatsAppTemplate({ 
                phoneNumberId, 
                to: from, 
                templateName: '5mp_final', 
                headerImage: IMAGES.hero_5mp, 
                buttonUrlParam: lead._id.toString(),
                io, 
                clientConfig 
            });
            if (!sent) { // Check for false, not just falsy
                // Fallback if template fails
                await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp', isAd: true, clientConfig });
            }
            return res.status(200).end();
        }
        if (txt.includes('3mp') || txt.includes('plus')) {
            await logActivity(lead._id, 'viewed_product', '3mp');
            const sent = await sendWhatsAppTemplate({ 
                phoneNumberId, 
                to: from, 
                templateName: '3mp_final', 
                headerImage: IMAGES.hero_3mp, 
                buttonUrlParam: lead._id.toString(),
                io, 
                clientConfig 
            });
            if (!sent) { // Check for false, not just falsy
                // Fallback if template fails
                await sendProductCard({ phoneNumberId, to: from, io, productKey: '3mp', isAd: true, clientConfig });
            }
            return res.status(200).end();
        }



        if (txt.includes('2mp')) {
            await sendProductCard({ phoneNumberId, to: from, io, productKey: '2mp', isAd: true, clientConfig });
            return res.status(200).end();
        }


        // --- AD LEAD INTENT (Priority) ---
        const adIntentRegex = /(details|know|about|price|info|tell me more)/i;
        if (adIntentRegex.test(txt)) {
            // Upsell Direct to 5MP Pro
            await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp', isAd: true, clientConfig });
            return res.status(200).end();
        }

        // --- GREETING INTENT ---
        const greetingRegex = /^(hi|hello|hey|hola|start|menu|kem cho)/i;
        if (greetingRegex.test(txt)) {
            await sendMainMenu({ phoneNumberId, to: from, io, clientConfig });
            return res.status(200).end();
        }
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
            case 'sel_3mp': 
                await logActivity(lead._id, 'viewed_product', '3mp');
                const sent3mp = await sendWhatsAppTemplate({ 
                    phoneNumberId, to: from, templateName: '3mp_final', headerImage: IMAGES.hero_3mp, 
                    buttonUrlParam: lead._id.toString(), io, clientConfig 
                });
                if (!sent3mp) await sendProductCard({ phoneNumberId, to: from, io, productKey: '3mp', clientConfig }); 
                break;
            case 'sel_5mp': 
                await logActivity(lead._id, 'viewed_product', '5mp');
                const sent5mp = await sendWhatsAppTemplate({ 
                    phoneNumberId, to: from, templateName: '5mp_final', headerImage: IMAGES.hero_5mp, 
                    buttonUrlParam: lead._id.toString(), io, clientConfig 
                });
                if (!sent5mp) await sendProductCard({ phoneNumberId, to: from, io, productKey: '5mp', clientConfig }); 
                break;

            // --- Buy Actions ---
            case 'buy_2mp': await sendPurchaseLink({ phoneNumberId, to: from, io, productKey: '2mp', clientConfig }); break;
            case 'buy_3mp': await sendPurchaseLink({ phoneNumberId, to: from, io, productKey: '3mp', clientConfig }); break;
            case 'buy_5mp': await sendPurchaseLink({ phoneNumberId, to: from, io, productKey: '5mp', clientConfig }); break;

            // --- FAQs ---
            case 'faq_install': await sendFAQAnswer({ phoneNumberId, to: from, io, key: 'install', clientConfig }); break;
            case 'faq_battery': await sendFAQAnswer({ phoneNumberId, to: from, io, key: 'battery', clientConfig }); break;
            case 'faq_warranty': await sendFAQAnswer({ phoneNumberId, to: from, io, key: 'warranty', clientConfig }); break;

            default: 
                // Handle Template Button Titles if ID is not direct
                if (userMsg.includes('View Doorbells')) {
                    await sendProductSelection({ phoneNumberId, to: from, io, clientConfig });
                } else if (userMsg.includes('Setup & FAQ')) {
                    await sendFAQMenu({ phoneNumberId, to: from, io, clientConfig });
                } else if (userMsg.includes('Talk to Agent')) {
                    // Build a rich context with product & cart info from lead
                    let agentContext = 'Requested help via WhatsApp';
                    if (lead) {
                        const lastViewed = [...(lead.activityLog || [])].reverse().find(l => l.action === 'viewed_product')?.details;
                        const cartTitles = lead.cartSnapshot?.titles?.length ? lead.cartSnapshot.titles : lead.cartSnapshot?.handles;
                        const cartQty = lead.cartSnapshot?.items?.reduce((sum, i) => sum + (i.quantity || 1), 0) || (cartTitles?.length || 0);
                        const cartPrice = lead.cartSnapshot?.total_price ? `₹${lead.cartSnapshot.total_price.toLocaleString()}` : null;
                        const parts = [];
                        if (cartTitles && cartTitles.length > 0) {
                            parts.push(`🛒 Cart (${cartQty} item${cartQty !== 1 ? 's' : ''}): ${cartTitles.join(', ')}${cartPrice ? ` | Total: ${cartPrice}` : ''}`);
                        }
                        if (lastViewed) parts.push(`👀 Last viewed: ${lastViewed}`);
                        if (parts.length > 0) agentContext = parts.join(' | ');
                    }
                    await handleAgentRequest({ phoneNumberId, to: from, context: agentContext, io, clientConfig });
                } else if (userMsg.includes('Order Now')) {
                    // Context-aware purchase link
                    let productKey = '3mp'; // Default fallback
                    const lastViewed = [...(lead.activityLog || [])].reverse().find(log => log.action === 'viewed_product')?.details;
                    if (lastViewed && ['5mp', '3mp', '2mp'].includes(lastViewed)) {
                        productKey = lastViewed;
                    }
                    await sendPurchaseLink({ phoneNumberId, to: from, io, productKey, clientConfig });

                } else {
                    await sendMainMenu({ phoneNumberId, to: from, io, clientConfig });
                }
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
    await sendWhatsAppTemplate({
        phoneNumberId,
        to,
        templateName: 'delitech_welcome',
        headerImage: IMAGES.hero_5mp, // Best general representation
        io,
        clientConfig
    });
}

/* OLD MAIN MENU REMOVED */
async function sendProductSelection({ phoneNumberId, to, io, clientConfig }) {
    await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: "Invest in your family's safety. Select a model below to view exclusive photos and pricing:\n\n*(Tip: Over 80% of our customers choose the 3MP Pro for absolute clarity)*",
        interactive: {
            type: 'list',
            header: { type: 'text', text: 'Select a Model' },
            action: {
                button: 'View Doorbells',
                sections: [
                    {
                        title: 'Premium Security',
                        rows: [
                            { id: 'sel_5mp', title: 'Doorbell Pro (5MP)', description: '👑 Ultimate Clarity & Smart AI' },
                            { id: 'sel_3mp', title: 'Doorbell Plus (3MP)', description: '⭐ 2K Video & Color Night Vision' }
                        ]
                    },
                    {
                        title: 'Essential Security',
                        rows: [
                            { id: 'sel_2mp', title: 'Doorbell (2MP)', description: 'Standard HD & 2-Way Talk' }
                        ]
                    },
                    {
                        title: 'Need Help Deciding?',
                        rows: [
                            { id: 'menu_agent', title: 'Consult an Expert', description: 'Get a free security callback' }
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
        body: `🛡️ *${product.name}*\n\n${product.full_desc}\n\n💰 *Offer Price:* ${product.price}\n✅ 1 Year Warranty | 🚚 Free Shipping | 🛠️ Free Installation`,

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
            io.emit('stats_update', {
                type: 'link_click',
                clientId: clientConfig.clientId,
                leadId: lead._id.toString(),
                phoneNumber: '+' + lead.phoneNumber,
                url: `.../${productKey}`,
                timestamp: new Date(),
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
        body: `⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 ${urlObj.toString()}\n\n_Cash on Delivery Available_\n_🚚 Free Shipping & 🛠️ Free Installation Included_`,

        io,
        clientConfig
    });
}

async function sendFeatureComparison({ phoneNumberId, to, io, clientConfig }) {
    await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: `🌟 *Why Delitech is India's Top Choice*\n\n *100% Wireless DIY*\nNo electricians. No drilling. 2-minute setup.\n\n *See Everything*\nCrystal clear Ultra-HD video and Color Night Vision.\n\n🗣️ *Stop Intruders Instantly*\nUse 2-Way Talk and the Built-In Siren from anywhere in the world.\n\n🌦️ *IP65 Weatherproof*\nWithstands heavy Indian monsoons and intense heat.`,
        interactive: {
            type: 'button',
            header: { type: 'image', image: { link: IMAGES.features } },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'menu_products', title: 'Shop Doorbells' } },
                    { type: 'reply', reply: { id: 'btn_back_menu', title: 'Main Menu' } }
                ]
            }
        }, io, clientConfig
    });
}

async function sendFAQMenu({ phoneNumberId, to, io, clientConfig }) {
    await sendWhatsAppInteractive({
        phoneNumberId, to,
        body: "🤖 *Smart Assistant FAQ*\nGot questions? I've got answers. Select a topic below:",
        interactive: {
            type: 'list',
            header: { type: 'text', text: 'Common Questions' },
            action: {
                button: 'View Guides',
                sections: [
                    {
                        title: 'Setup & Operation',
                        rows: [
                            { id: 'faq_install', title: 'How to install?', description: '100% Wireless DIY details' },
                            { id: 'faq_battery', title: 'Battery Life', description: 'Recharging & Weatherproofing' }
                        ]
                    },
                    {
                        title: 'Peace of Mind',
                        rows: [
                            { id: 'faq_warranty', title: 'Warranty Policy', description: '1-Year coverage guarantee' },
                            { id: 'menu_agent', title: 'Speak to a Human', description: 'Get personalized security advice' }
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

        const userMsgContent = messages.type === 'text' ? messages.text.body : 
                               messages.type === 'button' ? messages.button?.text :
                               (messages.interactive?.button_reply?.title || messages.interactive?.list_reply?.title || `[${messages.type}]`);

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

        // Update Conversation Last Message & Unread Count
        conversation.lastMessage = userMsgContent;
        conversation.lastMessageAt = new Date();
        if (conversation.status === 'HUMAN_TAKEOVER') {
            conversation.unreadCount = (conversation.unreadCount || 0) + 1;
        }
        await conversation.save();

        // Emit to dashboard immediately
        if (io) {
            io.to(`client_${clientId}`).emit('new_message', savedMsg);
            io.to(`client_${clientId}`).emit('conversation_update', conversation);
        }

        if (conversation.status === 'HUMAN_TAKEOVER') {
            return res.status(200).end();
        }

        // --- LEAD CAPTURE ---
        let updatedLead = null;
        try {
            updatedLead = await AdLead.findOneAndUpdate(
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

            if (updatedLead && io) {
                io.to(`client_${clientId}`).emit('stats_update', {
                    type: 'lead_activity',
                    lead: updatedLead
                });
            }
        } catch (e) { console.error('Lead Capture Error:', e); }

        await handleUserChatbotFlow({ 
            from: messages.from, 
            phoneNumberId: value.metadata.phone_number_id, 
            messages, 
            res, 
            io, 
            clientConfig,
            lead: updatedLead
        });

    } catch (err) { console.error('Webhook Error:', err.message); res.status(200).end(); }
};

const handleShopifyLinkOpenedWebhook = async (req, res) => {
    try {
        const { uid, page } = req.query; // Changed from req.body to req.query based on typical pixel implementation
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
            io.emit('stats_update', {
                type: 'link_click',
                clientId: updatedLead.clientId,
                leadId: updatedLead._id.toString(),
                phoneNumber: '+' + updatedLead.phoneNumber,
                url: page, // Assuming 'page' can represent the URL or context
                timestamp: now
            });
        }

        // Increment Daily Stats
        try {
            const today = new Date().toISOString().split('T')[0];
            await DailyStat.updateOne(
                { clientId: updatedLead.clientId, date: today },
                { $inc: { abandonedCartClicks: 1 } },
                { upsert: true }
            );
        } catch (e) { console.error("DailyStat Update Error (Click):", e); }

        return res.status(200).end();
    } catch (error) {
        console.error("Shopify link open tracking error:", error);
        return res.status(200).end();
    }
};

const handleShopifyCartUpdatedWebhook = async (req, res) => {
    try {
        const { uid, cartitems, product_titles, page, items, phone, total_price } = req.body;
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

        // Safely determine newly added handles to avoid empty arrays blocking alerts
        const added = newHandles.filter(h => !prevHandles.includes(h));
        // If it's a completely new cart session, treat all handles as added
        const isNewCart = ['purchased', 'abandoned', 'recovered'].includes(lead.cartStatus) || prevHandles.length === 0;
        const actualAdded = isNewCart ? newHandles : added;

        console.log("Shopify cart update for lead phone number:", lead.phoneNumber, "| added:", actualAdded);

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
                // ALWAYS clear isOrderPlaced so returning customers who previously
                // placed orders still receive cart recovery messages for new carts
                isOrderPlaced: false,
                adminFollowUpTriggered: false,
                lastInteraction: now,
                cartSnapshot: {
                    handles: newHandles,
                    titles: newTitles.length === newHandles.length ? newTitles : newHandles,
                    items: cartItemsArray,
                    total_price: total_price ? (total_price / 100) : 0,
                    updatedAt: now
                }
            },
            // ALWAYS clear these so the scheduler treats this as a fresh cart session
            $unset: {
                abandonedCartReminderSentAt: "",
                abandonedCartRecoveredAt: ""
            }
        };

        if (['purchased', 'abandoned', 'recovered'].includes(lead.cartStatus)) {
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
            io.emit('stats_update', {
                type: 'add_to_cart',
                clientId: lead.clientId,
                leadId: lead._id.toString(),
                phoneNumber: '+' + lead.phoneNumber,
                product_titles: actualAdded.map(h => newMap[h]),
                timestamp: now
            });
        }

        if (clientConfig && clientConfig.phoneNumberId && actualAdded.length > 0) {
            const context = `Added to cart: ${actualAdded.map(h => newMap[h]).join(', ')} | page: ${page || '/cart'}`;
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
            // If tracking hasn't synced the user's phone yet, we can't send an alert, but we still acknowledge
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
            io.emit('stats_update', {
                type: 'checkout_initiated',
                clientId: lead.clientId,
                leadId: lead._id.toString(),
                phoneNumber: '+' + lead.phoneNumber,
                product_titles: lead.cartSnapshot?.titles || [],
                timestamp: now
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
        let leadPhoneNumber = null;
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
                if (updatedLead) {
                    leadId = updatedLead._id;
                    leadPhoneNumber = updatedLead.phoneNumber;
                }
            }
        }

        // 3. Emit Socket Event for real-time dashboard
        if (io) {
            io.to(`client_${clientConfig.clientId}`).emit('new_order', newOrder);
            if (leadId) {
                io.emit('stats_update', {
                    type: 'order_placed', // Changed from link_click to order_placed
                    clientId: clientConfig.clientId,
                    leadId: leadId.toString(),
                    phoneNumber: '+' + leadPhoneNumber,
                    orderId: newOrder.orderId,
                    amount: totalPrice,
                    timestamp: new Date()
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
                    const sentTemplate = await sendWhatsAppTemplate({
                        phoneNumberId: clientConfig.phoneNumberId,
                        to: adminPhone,
                        templateName: 'delitech_admin_order',
                        bodyVariables: [orderId, customerName, phone, totalPrice.toLocaleString(), paymentMethod || 'N/A', addressString, itemNames],
                        io, clientConfig
                    });
                    
                    if (!sentTemplate) {
                        await sendWhatsAppText({ phoneNumberId: clientConfig.phoneNumberId, to: adminPhone, body: alertBody, io, clientConfig });
                    }
                }
            } catch (e) {
                console.error("Order admin notify error:", e.response?.data || e.message);
            }

            // 5. Notify Customer on WhatsApp
            try {
                if (phone) {
                    // Find the best product image to send
                    let productImageUrl = 'https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png'; // Default fallback

                    // 1. Check if order contains keywords matching our registered products in ved.js
                    const lowerItems = itemNames.toLowerCase();
                    if (lowerItems.includes('5mp')) {
                        productImageUrl = 'https://delitechsmarthome.in/cdn/shop/files/my1.png?v=1759746759&width=1346';
                    } else if (lowerItems.includes('3mp') || lowerItems.includes('2mp')) {
                        productImageUrl = 'https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png?v=1760635732&width=1346';
                    }
                    // 2. Fallback to webhook items if available (Shopify sometimes sends image under properties)
                    else if (items && items.length > 0 && items[0].image) {
                        productImageUrl = items[0].image.startsWith('//') ? `https:${items[0].image}` : items[0].image;
                    }
                    // 3. Fallback to searching the lead's cartSnapshot
                    else if (existingLead && existingLead.cartSnapshot && existingLead.cartSnapshot.items && existingLead.cartSnapshot.items.length > 0) {
                        const firstItemWithImage = existingLead.cartSnapshot.items.find(i => i.image);
                        if (firstItemWithImage && firstItemWithImage.image) {
                            productImageUrl = firstItemWithImage.image.startsWith('//') ? `https:${firstItemWithImage.image}` : firstItemWithImage.image;
                        }
                    }

                    const customerMessage = `🎉 *Order Confirmed! 🎉*\n\nHi ${customerName},\nThank you for choosing Delitech Smart Homes! 🏡✨\n\nYour order *${orderId}* has been successfully placed.\n\n📦 *Order Summary:*\n${itemNames}\n💰 *Total Value:* ₹${totalPrice.toLocaleString()}\n💳 *Payment:* ${paymentMethod || 'Online'}\n\n🚚 We are preparing your order and will notify you as soon as it ships.\n\nIf you have any questions, just reply to this message. We are here to help!`;

                    // Try to send the template first
                    const sentTemplate = await sendWhatsAppTemplate({
                        phoneNumberId: clientConfig.phoneNumberId,
                        to: phone,
                        templateName: 'delitech_order_format',
                        headerImage: productImageUrl,
                        bodyVariables: [customerName, orderId, itemNames, totalPrice.toLocaleString(), paymentMethod || 'Online'],
                        io, clientConfig
                    });

                    // Fallback to standard image message
                    if (!sentTemplate) {
                        await sendWhatsAppImage({
                            phoneNumberId: clientConfig.phoneNumberId,
                            to: phone,
                            imageUrl: productImageUrl,
                            caption: customerMessage,
                            io,
                            clientConfig
                        });
                    }
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

        // Shopify Cart Permalink to reconstruct items across browsers (local WhatsApp VS Safari)
        let cartUrl = `https://delitechsmarthome.in/cart?uid=${uid}&restore=true`;
        if (lead.cartSnapshot && lead.cartSnapshot.items && lead.cartSnapshot.items.length > 0) {
            const permalinkItems = lead.cartSnapshot.items.map(item => `${item.variant_id}:${item.quantity}`).join(',');
            cartUrl = `https://delitechsmarthome.in/cart/${permalinkItems}?uid=${uid}&restore=true`;
        }

        // Idempotency check to prevent duplicate restores/logs
        if (lead.cartStatus === 'recovered' || lead.cartStatus === 'purchased') {
            return res.redirect(cartUrl);
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

        // Increment Daily Stats (since restoreCart also implies a click)
        try {
            const today = new Date().toISOString().split('T')[0];
            await DailyStat.updateOne(
                { clientId: lead.clientId, date: today },
                { $inc: { abandonedCartClicks: 1 } },
                { upsert: true }
            );
        } catch (e) { console.error("DailyStat Update Error (Restore):", e); }

        res.redirect(cartUrl);
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
