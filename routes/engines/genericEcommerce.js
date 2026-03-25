const express = require('express');
const axios = require('axios');
const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Order = require('../../models/Order');
const DailyStat = require('../../models/DailyStat');
const ReviewRequest = require('../../models/ReviewRequest');
const { sendCODToPrepaidNudge } = require('../../utils/ecommerceHelpers');
const { sendOrderConfirmationEmail, sendCODToPrepaidEmail } = require('../../utils/emailService');

// --- 1. CORE API WRAPPERS ---

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
        conversation.lastMessage = body; 
        conversation.lastMessageAt = new Date(); 
        await conversation.save();
        if (io) { io.to(`client_${resolvedClientId}`).emit('new_message', savedMessage); }
    } catch (e) { console.error('[EcommerceEngine] DB Error:', e); }
}

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
    } catch (err) { console.error('[EcommerceEngine] Text Error:', err.message); return false; }
}

async function sendWhatsAppImage({ phoneNumberId, to, imageUrl, caption, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            to,
            type: 'image',
            image: { link: imageUrl, caption: caption }
        }, { headers: { Authorization: `Bearer ${token}` } });
        await saveAndEmitMessage({ phoneNumberId, to, body: `[Image Sent] ${caption}`, type: 'image', io, clientConfig });
        return true;
    } catch (e) { console.error('[EcommerceEngine] Image Error:', e.response?.data || e.message); return false; }
}

async function sendWhatsAppInteractive({ phoneNumberId, to, body, interactive, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    const data = { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: interactive.type, body: { text: body }, action: interactive.action } };
    if (interactive.header) data.interactive.header = interactive.header;
    if (interactive.footer) data.interactive.footer = interactive.footer;

    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, data, { headers: { Authorization: `Bearer ${token}` } });
        await saveAndEmitMessage({ phoneNumberId, to, body: `[Interactive] ${body}`, type: 'interactive', io, clientConfig, metadata: { interactive } });
        return true;
    } catch (err) { console.error('[EcommerceEngine] Interactive Error:', err.message); return false; }
}

async function logActivity(leadId, action, details) {
    if (!leadId) return;
    try {
        await AdLead.findByIdAndUpdate(leadId, { $push: { activityLog: { action, details, timestamp: new Date() } } });
    } catch (err) { console.error("[EcommerceEngine] Activity log error:", err.message); }
}


// --- 2. DYNAMIC MENUS (Powered by nicheData) ---

async function sendMainMenu({ phoneNumberId, to, io, clientConfig }) {
    const { nicheData = {} } = clientConfig;
    const welcomeMsg = nicheData.welcomeMessage || `Welcome to our store! How can we help you today?`;
    const image = nicheData.bannerImage;

    const interactive = {
        type: 'button',
        action: {
            buttons: [
                { type: 'reply', reply: { id: 'menu_products', title: '🛍️ Shop Now' } },
                { type: 'reply', reply: { id: 'menu_support', title: '❓ Support/FAQ' } }
            ]
        }
    };
    if (image) interactive.header = { type: 'image', image: { link: image } };

    await sendWhatsAppInteractive({ phoneNumberId, to, body: welcomeMsg, interactive, io, clientConfig });
}

async function sendCatalogue({ phoneNumberId, to, io, clientConfig }) {
    const { nicheData = {} } = clientConfig;
    const products = nicheData.products || [];
    
    if (products.length === 0) {
        return sendWhatsAppText({ phoneNumberId, to, body: "Our product catalog is currently being updated. Please check back soon!", io, clientConfig });
    }

    // Convert products to interactive list (max 10 items)
    const rows = products.slice(0, 10).map(p => ({
        id: `view_prod_${p.id}`,
        title: p.title.substring(0, 24),
        description: `${p.price} - ${p.shortDesc}`.substring(0, 72)
    }));

    const interactive = {
        type: 'list',
        header: { type: 'text', text: 'Our Collection 🛍️' },
        action: {
            button: 'View Catalog',
            sections: [{ title: 'Top Products', rows }]
        }
    };

    await sendWhatsAppInteractive({ phoneNumberId, to, body: "Browse our premium products below:", interactive, io, clientConfig });
}

async function sendProductDetails({ phoneNumberId, to, io, clientConfig, productId }) {
    const { nicheData = {} } = clientConfig;
    const products = nicheData.products || [];
    const product = products.find(p => p.id === productId);

    if (!product) return;

    const text = `*${product.title}*\n*Price:* ${product.price}\n\n${product.longDesc || product.shortDesc}\n\nTap below to order securely via WhatsApp!`;
    const interactive = {
        type: 'button',
        action: {
            buttons: [
                { type: 'reply', reply: { id: `buy_now_${product.id}`, title: '🛒 Buy Now' } },
                { type: 'reply', reply: { id: 'menu_products', title: '⬅️ Back to Shop' } }
            ]
        }
    };

    if (product.image) {
        interactive.header = { type: 'image', image: { link: product.image } };
    }

    await sendWhatsAppInteractive({ phoneNumberId, to, body: text, interactive, io, clientConfig });
}

function extractProductUrl(product, clientConfig, to) {
    if (product.url) return product.url;
    // Fallback store structure
    const storeUrl = clientConfig.nicheData?.storeUrl || '';
    if (storeUrl) return `${storeUrl}/products/${product.id}?utm_source=whatsapp&utm_medium=bot&uid=${to}`;
    return 'https://example.com'; 
}


// --- 3. WEBHOOK HANDLER ---

const handleWebhook = async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const value = entry?.changes?.[0]?.value;
        const messages = value?.messages?.[0];
        const phoneNumberId = value?.metadata?.phone_number_id;
        const from = messages?.from;

        if (!messages || !from) return res.status(200).end();

        const { clientId, whatsappToken: token, nicheData, plan } = req.clientConfig;
        const io = req.app.get('socketio');
        const helperParams = { phoneNumberId, token, io, clientConfig: req.clientConfig };
        let userMsg = '';
        let interactiveId = '';
        const userMsgType = messages.type;

        if (userMsgType === 'text') userMsg = messages.text.body.trim();
        else if (userMsgType === 'interactive') {
            interactiveId = messages.interactive.button_reply?.id || messages.interactive.list_reply?.id;
            userMsg = messages.interactive.button_reply?.title || messages.interactive.list_reply?.title;
        } else if (userMsgType === 'button') {
            userMsg = messages.button?.text || "";
            interactiveId = messages.button?.payload || "";
        }

        // --- Log Incoming Message to DB ---
        let conversation = await Conversation.findOne({ phone: from, clientId });
        if (!conversation) {
            conversation = await Conversation.create({ phone: from, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
        }

        const savedMsg = await Message.create({
            clientId, conversationId: conversation._id, from, to: 'bot',
            content: userMsg || `[${userMsgType}]`, type: userMsgType, direction: 'incoming', status: 'received'
        });

        conversation.lastMessage = userMsg || `[${userMsgType}]`;
        conversation.lastMessageAt = new Date();
        if (conversation.status === 'HUMAN_TAKEOVER') conversation.unreadCount = (conversation.unreadCount || 0) + 1;
        await conversation.save();

        if (io) {
            io.to(`client_${clientId}`).emit('new_message', savedMsg);
            io.to(`client_${clientId}`).emit('conversation_update', conversation);
        }

        if (conversation.status === 'HUMAN_TAKEOVER') {
            console.log(`[EcommerceEngine] Takeover active for ${from}`);
            return res.status(200).end();
        }

        let lead = await AdLead.findOne({ phoneNumber: from, clientId });

        // --- Handle Interactive Actions ---
        if (interactiveId) {
            if (interactiveId === 'menu_products') {
                if (lead) await logActivity(lead._id, 'navigated', 'Product Menu');
                await sendCatalogue({ ...helperParams, to: from });
                return res.status(200).end();
            }
            if (interactiveId.startsWith('view_prod_')) {
                const pId = interactiveId.replace('view_prod_', '');
                if (lead) await logActivity(lead._id, 'viewed_product', pId);
                await sendProductDetails({ ...helperParams, to: from, productId: pId });
                return res.status(200).end();
            }
            if (interactiveId.startsWith('buy_now_')) {
                const pId = interactiveId.replace('buy_now_', '');
                const products = nicheData.products || [];
                const product = products.find(p => p.id === pId);
                if (product) {
                    const url = extractProductUrl(product, req.clientConfig, from);
                    await sendWhatsAppText({ ...helperParams, to: from, body: `Great choice! Tap the secure link below to complete your order:\n\n👉 ${url}\n\nNeed help? Just reply to this message!` });
                }
                return res.status(200).end();
            }

            // Reviews system
            if (interactiveId.startsWith('rv_good_') || interactiveId.startsWith('rv_ok_')) {
                const reviewId = interactiveId.split("_").pop();
                await ReviewRequest.findByIdAndUpdate(reviewId, { status: "responded_positive" });
                const rLink = nicheData.googleReviewUrl || 'https://google.com';
                await sendWhatsAppText({ ...helperParams, to: from, body: `Thank you so much! 🙏 Please take 30 seconds to drop us a 5-star review here: ${rLink}` });
                return res.status(200).end();
            }
            if (interactiveId.startsWith('rv_bad_')) {
                const reviewId = interactiveId.split("_").pop();
                await ReviewRequest.findByIdAndUpdate(reviewId, { status: "responded_negative" });
                await sendWhatsAppText({ ...helperParams, to: from, body: `We're really sorry to hear that. A manager will text you shortly to resolve this.` });
                conversation.status = 'HUMAN_TAKEOVER';
                await conversation.save();
                return res.status(200).end();
            }
        }

        // --- Handle Text Input (Greeting & AI Fallback) ---
        if (userMsgType === 'text') {
            const txt = userMsg.toLowerCase();
            if (/^(hi|hello|hey|start|menu|shop)/i.test(txt)) {
                await sendMainMenu({ ...helperParams, to: from });
                return res.status(200).end();
            }

            // Gemini AI Fallback for Product Queries
            if (plan === 'CX Agent (V2)' && req.clientConfig.geminiApiKey) {
                const prompt = `You are an AI sales agent for an ecommerce store. 
                Knowledge Base: ${nicheData.knowledgeBase || JSON.stringify(nicheData.products || {})}
                If they want to buy, instruct them to type "shop" to see the menu.
                User: ${userMsg}
                Reply politely and concisely.`;

                try {
                    const resp = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${req.clientConfig.geminiApiKey}`, {
                        contents: [{ parts: [{ text: prompt }] }]
                    });
                    const aiText = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (aiText) await sendWhatsAppText({ ...helperParams, to: from, body: aiText });
                } catch (e) { console.error('[EcommerceEngine] AI Error'); }
                return res.status(200).end();
            }

            // Default fallback
            await sendMainMenu({ ...helperParams, to: from });
        }

        return res.status(200).end();
    } catch (err) {
        console.error('[EcommerceEngine] Webhook Error:', err);
        return res.status(200).end(); // Acknowledge Meta
    }
};

// --- 4. SHOPIFY WEBHOOK PARSERS ---

const handleShopifyCartUpdatedWebhook = async (req, res) => {
    try {
        const cartData = req.body;
        const phoneRaw = cartData.phone || cartData.customer?.phone || cartData.billing_address?.phone || cartData.shipping_address?.phone;
        const { clientId } = req.clientConfig;

        console.log(`[EcommerceEngine] Cart Update Webhook for ${clientId} | Phone: ${phoneRaw || 'NONE'}`);
        if (!phoneRaw) return res.status(200).end();
        const phone = phoneRaw.replace(/\D/g, ''); // strip to digits

        let lead = await AdLead.findOne({ phoneNumber: phone, clientId });
        if (!lead) lead = new AdLead({ phoneNumber: phone, clientId, status: 'new' });

        const snapshot = {
            token: cartData.token || cartData.id,
            items: cartData.line_items?.map(item => ({ product_id: item.product_id, variant_id: item.variant_id, quantity: item.quantity, price: item.price, image: item.image })) || [],
            total_price: cartData.total_price
        };

        lead.cartSnapshot = snapshot;
        lead.cartStatus = 'active';
        lead.lastActiveAt = new Date();
        // Reset abandoned cart timers
        lead.abandonedCartReminder1Sent = false;
        lead.abandonedCartReminder2Sent = false;
        lead.abandonedCartAI1Sent = false;

        await lead.save();
        res.status(200).end();
    } catch (e) {
        console.error('[EcommerceEngine] Cart Webhook Error', e);
        res.status(200).end();
    }
};

const handleShopifyCheckoutInitiatedWebhook = async (req, res) => {
    // Almost identical logic to Cart Update
    await handleShopifyCartUpdatedWebhook(req, res);
};

const handleShopifyOrderCompleteWebhook = async (req, res) => {
    try {
        const orderData = req.body;
        const phoneRaw = orderData.phone || orderData.customer?.phone || orderData.billing_address?.phone || orderData.shipping_address?.phone;
        const { clientId, whatsappToken: token } = req.clientConfig;
        
        console.log(`[EcommerceEngine] Order Complete Webhook for ${clientId} | Order: ${orderData.name} | Phone: ${phoneRaw}`);
        if (!phoneRaw) return res.status(200).end();
        const phone = phoneRaw.replace(/\D/g, '');

        const orderId = orderData.id;
        const orderNumber = orderData.name;
        const totalPrice = orderData.total_price;
        const isCOD = orderData.gateway?.toLowerCase().includes('cash on delivery') || orderData.gateway?.toLowerCase().includes('cod');
        const items = orderData.line_items?.map(i => `${i.name} (x${i.quantity})`).join(', ') || 'Your items';

        // Log Order Document
        const savedOrder = await Order.create({
            clientId,
            storeString: 'Shopify',
            orderId: orderId.toString(),
            orderNumber,
            totalPrice,
            customerPhone: phone,
            customerEmail: orderData.customer?.email || orderData.email || null,
            customerName: orderData.customer?.first_name || 'Customer',
            name: orderData.customer?.first_name || 'Customer',
            paymentMethod: isCOD ? 'COD' : 'Prepaid',
            items: orderData.line_items?.map(i => ({ name: i.name, quantity: i.quantity, price: i.price })) || []
        });

        // Mark Lead as Purchased
        await AdLead.findOneAndUpdate(
            { phoneNumber: phone, clientId },
            { $set: { status: 'purchased', cartStatus: 'purchased' } }
        );

        // Notify User via WhatsApp
        const helperParams = { phoneNumberId: req.clientConfig.phoneNumberId, token, io: req.app.get('socketio'), clientConfig: req.clientConfig };
        const msg = `🎉 *Order Confirmed!* 🎉\n\nHi ${orderData.customer?.first_name || 'there'},\nThanks for your purchase! 🛍️\n\n📦 *Order Summary:* ${items}\n💰 *Total:* ₹${totalPrice}\n💳 *Payment:* ${isCOD ? 'Cash on Delivery (COD)' : 'Prepaid Online'}\n\nWe will update you once it ships.`;
        await sendWhatsAppText({ ...helperParams, to: phone, body: msg });

        // 📧 Also send order confirmation email if customer email is available
        const customerEmail = orderData.customer?.email || orderData.email;
        if (customerEmail) {
            await sendOrderConfirmationEmail(req.clientConfig, {
                customerEmail,
                customerName: orderData.customer?.first_name || 'Customer',
                orderId: orderId.toString(),
                orderNumber,
                items: orderData.line_items?.map(i => `${i.name} (x${i.quantity})`) || [],
                totalPrice,
                paymentMethod: isCOD ? 'Cash on Delivery (COD)' : 'Prepaid Online'
            });
        }

        return res.status(200).end();
    } catch (e) {
        console.error('[EcommerceEngine] Order Webhook Error', e);
        res.status(200).end();
    }
};


const handleShopifyLinkOpenedWebhook = async (req, res) => {
    try {
        const { phone, clientId } = req.body;
        if (!phone) return res.status(200).end();
        let lead = await AdLead.findOne({ phoneNumber: phone, clientId });
        if (lead) {
            await logActivity(lead._id, 'link_opened', 'User clicked tracking link');
        }
        res.status(200).end();
    } catch (e) {
        console.error('[EcommerceEngine] Link Webhook Error', e);
        res.status(200).end();
    }
};

const getClientOrders = async (req, res) => {
    try {
        const clientConfig = req.clientConfig;
        const orders = await Order.find({ clientId: clientConfig.clientId }).sort({ createdAt: -1 }).limit(100);
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: 'Server configuration error' });
    }
};

const getCartSnapshot = async (req, res) => {
    try {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ success: false, message: 'UID missing' });

        let leadData = null;
        if (uid && /^[0-9a-fA-F]{24}$/.test(uid)) {
            leadData = await AdLead.findById(uid).catch(() => null);
        }
        if (!leadData) {
            leadData = await AdLead.findOne({ phoneNumber: uid }).catch(() => null);
        }

        if (!leadData || !leadData.cartSnapshot) return res.status(404).json({ success: false, message: 'Cart not found' });

        res.json({ success: true, cart: leadData.cartSnapshot });
    } catch (err) {
        res.status(500).json({ success: false });
    }
};

const restoreCart = async (req, res) => {
    try {
        const { uid } = req.query;
        if (!uid) return res.status(400).send('UID missing');

        let lead = null;
        if (uid.length === 24) lead = await AdLead.findById(uid);
        if (!lead) return res.status(404).send('Cart not found');

        // Fetch client to get storeUrl
        const Client = require('../../models/Client');
        const clientDesc = await Client.findOne({ clientId: lead.clientId });
        const storeUrl = clientDesc?.nicheData?.storeUrl || process.env.STORE_URL || 'https://example.com';

        let cartUrl = `${storeUrl}/cart?uid=${uid}&restore=true`;
        if (lead.cartSnapshot && lead.cartSnapshot.items && lead.cartSnapshot.items.length > 0) {
            const permalinkItems = lead.cartSnapshot.items.map(item => `${item.variant_id}:${item.quantity}`).join(',');
            cartUrl = `${storeUrl}/cart/${permalinkItems}?uid=${uid}&restore=true`;
        }

        if (lead.cartStatus === 'recovered' || lead.cartStatus === 'purchased') return res.redirect(cartUrl);

        await AdLead.findByIdAndUpdate(lead._id, {
            $set: { cartStatus: 'recovered', abandonedCartRecoveredAt: new Date() },
            $push: { activityLog: { action: 'whatsapp_restore_link_clicked', details: 'User clicked restore cart link', timestamp: new Date() } }
        });

        try {
            const today = new Date().toISOString().split('T')[0];
            await DailyStat.updateOne(
                { clientId: lead.clientId, date: today },
                { $inc: { abandonedCartClicks: 1 } },
                { upsert: true }
            );
        } catch (e) { }

        res.redirect(cartUrl);
    } catch (error) {
        res.status(500).send('An error occurred while restoring the cart');
    }
};

const logRestoreEvent = async (req, res) => {
    try {
        const { uid, action, details } = req.body;
        if (!uid) return res.status(400).end();

        let lead = null;
        if (uid.length === 24) lead = await AdLead.findById(uid);
        if (!lead) return res.status(404).end();

        await AdLead.findByIdAndUpdate(lead._id, {
            $push: { activityLog: { action: action || 'restore_failed', details: details || 'Unknown error', timestamp: new Date(), meta: {} } }
        });

        res.status(200).json({ success: true });
    } catch (err) {
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
