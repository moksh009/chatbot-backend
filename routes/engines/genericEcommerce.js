const express = require('express');
const axios = require('axios');
const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Order = require('../../models/Order');
const DailyStat = require('../../models/DailyStat');
const ReviewRequest = require('../../models/ReviewRequest');
const { sendOrderConfirmationEmail, sendCODToPrepaidEmail } = require('../../utils/emailService');
const { runDualBrainEngine } = require('../../utils/dualBrainEngine');

// --- 1. CORE API WRAPPERS ---
async function findNextNode(currentNodeId, handleId, edges) {
    console.log(`[FlowEngine] Finding path from ${currentNodeId} with handle: ${handleId}`);
    // Prioritize sourceHandle match, fallback to any edge from that node if no handle is specified
    const edge = edges.find(e => e.source === currentNodeId && (handleId ? e.sourceHandle === handleId : true));
    if (!edge) {
         // Fallback: look for ANY edge from this node if handleId didn't match (sometimes handles IDs are messy)
         const fallbackEdge = edges.find(e => e.source === currentNodeId);
         if (fallbackEdge && !handleId) return fallbackEdge.target;
    }
    return edge ? edge.target : null;
}

async function executeNode({ nodeId, nodes, edges, to, phoneNumberId, io, clientConfig }) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    console.log(`[FlowEngine] Executing Node: ${node.id} (${node.type})`);

    // Update conversation's current step
    await Conversation.findOneAndUpdate({ phone: to, clientId: clientConfig.clientId }, { lastStepId: node.id });

    if (node.type === 'message') {
        const { title, text, imageUrl, footer } = node.data;
        if (imageUrl) {
            await sendWhatsAppImage({ phoneNumberId, to, imageUrl, caption: text, io, clientConfig });
        } else {
            await sendWhatsAppText({ phoneNumberId, to, body: text, io, clientConfig });
        }
        // Auto-traverse to next if there's only one outgoing edge
        const nextNodeId = await findNextNode(node.id, null, edges);
        if (nextNodeId) await executeNode({ nodeId: nextNodeId, nodes, edges, to, phoneNumberId, io, clientConfig });
    } 
    else if (node.type === 'interactive') {
        const { header, text, imageUrl, buttonsList = [], buttons, footer, actionType, btnUrlTitle, btnUrlLink } = node.data;
        let interactive = {};

        if (actionType === 'url') {
            interactive = {
                type: 'cta_url',
                action: {
                    name: 'cta_url',
                    parameters: {
                        display_text: (btnUrlTitle || 'Visit Website').substring(0, 20),
                        url: btnUrlLink || 'https://google.com'
                    }
                }
            };
        } else {
            const finalButtons = Array.isArray(buttonsList) && buttonsList.length > 0
                ? buttonsList 
                : (buttons || '').split(',').map(b => b.trim()).filter(Boolean).map(b => ({ id: b.toLowerCase().replace(/\s+/g, '_'), title: b }));

            if (finalButtons.length === 0) {
                console.warn(`[FlowEngine] Interactive node ${node.id} has no buttons! Falling back to text.`);
                await sendWhatsAppText({ phoneNumberId, to, body: text, io, clientConfig });
                return;
            }

            interactive = {
                type: 'button',
                action: {
                    buttons: finalButtons.slice(0, 3).map(btn => ({
                        type: 'reply',
                        reply: { 
                            id: btn.id || btn.title.toLowerCase().replace(/\s+/g, '_'), 
                            title: (btn.title || 'click').substring(0, 20) 
                        }
                    }))
                }
            };
        }

        if (imageUrl) interactive.header = { type: 'image', image: { link: imageUrl } };
        else if (header) interactive.header = { type: 'text', text: header.substring(0, 60) };
        if (footer) interactive.footer = { type: 'text', text: footer.substring(0, 60) };

        const success = await sendWhatsAppInteractive({
            phoneNumberId, to, body: text || 'Choose an option:', interactive, io, clientConfig
        });
        if (!success) {
            console.error(`[FlowEngine] Interactive failed, falling back to basic text.`);
            await sendWhatsAppText({ phoneNumberId, to, body: text, io, clientConfig });
        }
    }
    else if (node.type === 'template') {
        const { templateName, variables = '', headerImageUrl } = node.data;
        const bodyParams = variables.split(',').map(v => v.trim()).filter(Boolean);
        
        let finalImageUrl = headerImageUrl;
        const tplDef = (clientConfig.waTemplates || []).find(t => t.name === templateName);
        if (tplDef) {
             const needsImage = tplDef.components?.some(c => c.type === 'HEADER' && c.format === 'IMAGE');
             if (needsImage && !headerImageUrl) {
                 finalImageUrl = 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&q=80&w=1000';
             }
        }

        await sendWhatsAppTemplate({
            phoneNumberId, to, templateName, bodyParams, headerImageUrl: finalImageUrl, io, clientConfig
        });
        // Auto-traverse to NEXT handle "a" (default)
        const nextNodeId = await findNextNode(node.id, "a", edges);
        if (nextNodeId) await executeNode({ nodeId: nextNodeId, nodes, edges, to, phoneNumberId, io, clientConfig });
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
    
    // Strict Sanitization to avoid 400 Bad Request
    const sanitizedBody = (body || 'Choose an option:').substring(0, 1024);
    const sanitizedAction = { ...interactive.action };
    
    if (sanitizedAction.buttons) {
        // IDs must be unique and <= 256 chars, Titles <= 20 chars
        const seenIds = new Set();
        sanitizedAction.buttons = sanitizedAction.buttons.map((b, i) => {
            let id = (b.reply?.id || `btn_${i}`).substring(0, 256);
            if (seenIds.has(id)) id = `${id}_${i}`;
            seenIds.add(id);
            return {
                ...b,
                reply: {
                    id,
                    title: (b.reply?.title || 'Click').substring(0, 20)
                }
            };
        });
    }

    const data = { 
        messaging_product: 'whatsapp', to, type: 'interactive', 
        interactive: { 
            type: interactive.type, 
            body: { text: sanitizedBody }, 
            action: sanitizedAction 
        } 
    };
    
    if (interactive.header) {
        if (interactive.header.type === 'text') {
            data.interactive.header = { type: 'text', text: interactive.header.text.substring(0, 60) };
        } else {
            data.interactive.header = interactive.header;
        }
    }
    if (interactive.footer) {
        data.interactive.footer = { text: (typeof interactive.footer === 'string' ? interactive.footer : (interactive.footer.text || '')).substring(0, 60) };
    }

    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, data, { headers: { Authorization: `Bearer ${token}` } });
        await saveAndEmitMessage({ phoneNumberId, to, body: `[Interactive] ${sanitizedBody}`, type: 'interactive', io, clientConfig, metadata: { interactive: data.interactive } });
        return true;
    } catch (err) { 
        console.error('[EcommerceEngine] Interactive Error Detail:', JSON.stringify(err.response?.data || err.message)); 
        return false; 
    }
}

async function logActivity(leadId, action, details) {
    if (!leadId) return;
    try {
        await AdLead.findByIdAndUpdate(leadId, { $push: { activityLog: { action, details, timestamp: new Date() } } });
    } catch (err) { console.error("[EcommerceEngine] Activity log error:", err.message); }
}

async function sendWhatsAppTemplate({ phoneNumberId, to, templateName, languageCode = 'en', headerImageUrl = null, bodyParams = [], buttonUrlParam = null, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    try {
        const templateData = { name: templateName, language: { code: languageCode }, components: [] };
        if (headerImageUrl) {
            templateData.components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] });
        }
        if (bodyParams.length > 0) {
            templateData.components.push({ type: 'body', parameters: bodyParams.map(text => ({ type: 'text', text: String(text) })) });
        }
        if (buttonUrlParam) {
            templateData.components.push({
                type: 'button',
                sub_type: 'url',
                index: 0,
                parameters: [{ type: 'text', text: String(buttonUrlParam) }]
            });
        }

        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
            messaging_product: 'whatsapp', to, type: 'template', template: templateData
        }, { headers: { Authorization: `Bearer ${token}` } });
        
        await saveAndEmitMessage({ phoneNumberId, to, body: `[Template Sent] ${templateName}`, type: 'template', io, clientConfig });
        return true;
    } catch (err) { 
        console.error('[EcommerceEngine] Template Error:', err.response?.data || err.message); 
        return false; 
    }
}

async function sendDynamicMessage({ stepId, fallbackInteractive, phoneNumberId, to, io, clientConfig, templateParams = {} }) {
    const mappedTpl = (clientConfig.messageTemplates || []).find(t => t.id === stepId);
    console.log(`[sendDynamicMessage] Resolve Step: ${stepId} | Found Template: ${mappedTpl?.templateName || 'NONE'} | Type: ${mappedTpl?.type || 'standard'}`);
    
    if (mappedTpl && mappedTpl.type === 'meta_template' && mappedTpl.templateName) {
        let bodyParams = templateParams.variables || [];
        // Extract common params if they exist in nicheData for dynamic body
        if (bodyParams.length === 0 && clientConfig.nicheData) {
           const nd = clientConfig.nicheData;
           // If welcome message, try to extract from nicheData
           if (stepId === 'welcome_menu') {
              // Usually welcome templates don't take params, but if they do:
           }
        }
        
        let buttonUrlParam = templateParams.buttonUrlParam || to; 

        const success = await sendWhatsAppTemplate({
            phoneNumberId, to, io, clientConfig,
            templateName: mappedTpl.templateName,
            headerImageUrl: mappedTpl.headerImage || null,
            bodyParams,
            buttonUrlParam,
            languageCode: 'en'
        });
        if (success) return true;
        console.warn(`[EcommerceEngine] Meta template ${mappedTpl.templateName} failed. Falling back to interactive.`);
    }

    if (fallbackInteractive.type === 'interactive') {
        return await sendWhatsAppInteractive({
            phoneNumberId, to, io, clientConfig,
            body: fallbackInteractive.body,
            interactive: fallbackInteractive.interactive
        });
    } else if (fallbackInteractive.type === 'text') {
        return await sendWhatsAppText({
            phoneNumberId, to, io, clientConfig,
            body: fallbackInteractive.body
        });
    }
}


// --- 2. DYNAMIC MENUS (Powered by nicheData) ---

async function sendMainMenu({ phoneNumberId, to, io, clientConfig }) {
    const { nicheData = {} } = clientConfig;
    const bannerUrl = nicheData.bannerImage;
    const websiteUrl = nicheData.storeUrl || nicheData.websiteUrl;
    
    // Use simplified setting if available
    const welcomeText = nicheData.welcomeMessage || `Welcome to our store! How can we help you today?`;
    const btnText = nicheData.flowButtonText || '🛍️ Shop Now';

    const interactive = {
        type: 'button',
        action: {
            buttons: [
                { type: 'reply', reply: { id: 'menu_products', title: btnText.substring(0, 20) } },
                { type: 'reply', reply: { id: 'menu_support', title: '❓ Support/FAQ' } }
            ]
        }
    };
    if (bannerUrl) interactive.header = { type: 'image', image: { link: bannerUrl } };
    else interactive.header = { type: 'text', text: 'Official Store 🛍️' };

    await sendWhatsAppInteractive({
        phoneNumberId, to, body: welcomeText, interactive, io, clientConfig
    });
}

async function sendCatalogue({ phoneNumberId, to, io, clientConfig }) {
    const { nicheData = {} } = clientConfig;
    const products = nicheData.products || [];
    
    if (products.length === 0) {
        return sendWhatsAppText({ phoneNumberId, to, body: "Our product catalog is currently being updated. Please check back soon!", io, clientConfig });
    }

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

    await sendDynamicMessage({
        stepId: 'catalog_menu',
        fallbackInteractive: { type: 'interactive', body: "Browse our premium products below:", interactive },
        phoneNumberId, to, io, clientConfig
    });
}

async function sendSupportMenu({ phoneNumberId, to, io, clientConfig }) {
    const { nicheData = {} } = clientConfig;
    const faqs = nicheData.faqs || [];
    
    // If simplified support reply is set, send that instead of the list
    if (nicheData.supportReply) {
        await sendWhatsAppText({
            phoneNumberId, to, body: nicheData.supportReply, io, clientConfig
        });
        return;
    }

    if (faqs.length === 0) {
        await sendWhatsAppText({ phoneNumberId, to, body: "Our support team is currently offline. Please wait while we connect you to an agent.", io, clientConfig });
        return;
    }

    const rows = faqs.slice(0, 8).map(f => ({
        id: `faq_${f.id}`,
        title: f.question.substring(0, 24)
    }));
    
    rows.push({ id: 'menu_agent', title: '📞 Talk to Agent' });

    const interactive = {
        type: 'list',
        header: { type: 'text', text: 'Help & Support' },
        action: {
            button: 'View Options',
            sections: [{ title: 'Common Questions', rows }]
        }
    };

    await sendDynamicMessage({
        stepId: 'support_menu',
        fallbackInteractive: { type: 'interactive', body: "Select a topic below to get instant answers:", interactive },
        phoneNumberId, to, io, clientConfig
    });
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

    await sendDynamicMessage({
        stepId: `view_prod_${product.id}`,
        fallbackInteractive: { type: 'interactive', body: text, interactive },
        phoneNumberId, to, io, clientConfig,
        templateParams: {
            variables: [product.title, product.price],
            buttonUrlParam: to // Track link clicks by passing phone number
        }
    });
}

function extractProductUrl(product, clientConfig, to) {
    if (product.url) return product.url;
    // Fallback store structure
    const storeUrl = clientConfig.nicheData?.storeUrl || '';
    if (storeUrl) return `${storeUrl}/products/${product.id}?utm_source=whatsapp&utm_medium=bot&uid=${to}`;
    return 'https://example.com'; 
}

async function sendCODToPrepaidNudge(order, clientConfig, phone) {
    const { createCODPaymentLink } = require('../../utils/razorpay');

    let paymentUrl;
    try {
        const link = await createCODPaymentLink(order, clientConfig);
        paymentUrl = link.short_url;
        await Order.findByIdAndUpdate(order._id, {
            razorpayLinkId: link.id,
            razorpayUrl: link.short_url,
            codNudgeSentAt: new Date()
        });
    } catch (err) {
        console.error("[EcommerceEngine] Razorpay link failed:", err.message);
        return;
    }

    const template = (clientConfig.messageTemplates || []).find(t => t.id === "cod_to_prepaid");
    const itemName = order.items?.[0]?.name || "your product";
    const discount = clientConfig.automationFlows?.find(f => f.id === "cod_to_prepaid")?.config?.discountAmount || 50;

    const bodyText = template?.body
        ? template.body
            .replace("{{order_number}}", order.orderNumber)
            .replace("{{product_name}}", itemName)
            .replace("{{discount_amount}}", discount)
        : `Your order #${order.orderNumber} for *${itemName}* (₹${order.totalPrice}) is confirmed via COD.\n\n💳 Pay via UPI now and save ₹${discount}!\n\nOffer expires in 2 hours.`;

    const btn1Label = template?.buttons?.[0]?.label || "💳 Pay via UPI";
    const btn2Label = template?.buttons?.[1]?.label || "Keep COD";

    const interactive = {
        type: "button",
        header: { type: "text", text: "Quick Payment Offer 🎁" },
        action: {
            buttons: [
                { type: "reply", reply: { id: `cod_pay_${order._id}`, title: btn1Label.substring(0, 20) } },
                { type: "reply", reply: { id: `cod_keep_${order._id}`, title: btn2Label.substring(0, 20) } }
            ]
        }
    };

    await sendWhatsAppInteractive({
        phoneNumberId: clientConfig.phoneNumberId,
        to: phone,
        body: bodyText,
        interactive,
        io: global.io || null,
        clientConfig
    });
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

        // Parse Message
        const parsedMessage = {
            ...messages,
            from,
            messageId: messages.id
        };

        // --- DUAL-BRAIN ENGINE (Graph -> Keyword -> AI) ---
        // Includes: Upsert Convo, Upsert Lead, Save Inbound Message, Paused Check, Graph, Keyword, Gemini text fallback
        const handledByDualBrain = await runDualBrainEngine(parsedMessage, req.clientConfig);

        // If DualBrain consumed the message fully (e.g. matched a graph edge, or text was matched by AI), we stop.
        // It returns false ONLY if no graph matched AND there's no text (e.g. a legacy interactive button click that wasn't in the tree).
        if (handledByDualBrain) {
            return res.status(200).end();
        }

        // --- LEGACY INTERACTIVE ACTIONS FLAG ---
        let interactiveId = '';
        if (messages.type === 'interactive') {
            interactiveId = messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id || '';
        } else if (messages.type === 'button') {
            interactiveId = messages.button?.payload || '';
        }

        let lead = await AdLead.findOne({ phoneNumber: from, clientId });
        let conversation = await Conversation.findOne({ phone: from, clientId });

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

            if (interactiveId === 'menu_support') {
                if (lead) await logActivity(lead._id, 'navigated', 'Support Menu');
                await sendSupportMenu({ ...helperParams, to: from });
                return res.status(200).end();
            }

            if (interactiveId.startsWith('faq_')) {
                const fId = interactiveId.replace('faq_', '');
                const faqs = nicheData.faqs || [];
                const faq = faqs.find(f => f.id === fId);
                if (faq) {
                    if (lead) await logActivity(lead._id, 'read_faq', faq.question);
                    await sendWhatsAppText({ ...helperParams, to: from, body: `*${faq.question}*\n\n${faq.answer}` });
                }
                return res.status(200).end();
            }

            if (interactiveId === 'menu_agent') {
                if (lead) await logActivity(lead._id, 'action', 'Requested Agent');
                await sendWhatsAppText({ ...helperParams, to: from, body: `✅ *Request Received!*\n\nOur human agent has been notified and will reply shortly to your number.` });
                conversation.status = 'HUMAN_TAKEOVER';
                await conversation.save();
                return res.status(200).end();
            }

            // --- Phase 7 ROI & Review Actions ---
            if (interactiveId.startsWith('cod_pay_')) {
                const orderId = interactiveId.replace("cod_pay_", "");
                const order = await Order.findById(orderId);
                if (order?.razorpayUrl) {
                    const msg = `Here's your secure payment link 🔐\n\n👉 ${order.razorpayUrl}\n\nPay via GPay, PhonePe, or any UPI. Valid for 2 hours.`;
                    await sendWhatsAppText({ ...helperParams, to: from, body: msg });
                }
                return res.status(200).end();
            }

            if (interactiveId.startsWith('cod_keep_')) {
                await sendWhatsAppText({ ...helperParams, to: from, body: "No problem! Your COD order is confirmed. We'll deliver soon. 📦" });
                return res.status(200).end();
            }

            if (interactiveId.startsWith('rv_good_')) {
                const reviewId = interactiveId.replace("rv_good_", "");
                const review = await ReviewRequest.findById(reviewId);
                await ReviewRequest.findByIdAndUpdate(reviewId, { status: "responded_positive", response: "positive" });
                const { startOfDay } = require("date-fns");
                await DailyStat.findOneAndUpdate(
                    { clientId: req.clientConfig.clientId, date: startOfDay(new Date()) },
                    { $inc: { reviewsCollected: 1, reviewsPositive: 1 } },
                    { upsert: true }
                );
                const reviewUrl = review?.reviewUrl || nicheData.googleReviewUrl || req.clientConfig.googleReviewUrl || "";
                const replyText = reviewUrl
                    ? `Thank you so much! 🙏 Could you leave a quick Google review? Takes 30 seconds!\n\n⭐ ${reviewUrl}\n\nMeans the world to us!`
                    : `Thank you so much! 🙏 Your feedback means everything to us!`;
                await sendWhatsAppText({ ...helperParams, to: from, body: replyText });
                if (io) io.to(`client_${req.clientConfig.clientId}`).emit("stats_update", { type: "review_positive" });
                return res.status(200).end();
            }

            if (interactiveId.startsWith('rv_ok_')) {
                const reviewId = interactiveId.replace("rv_ok_", "");
                await ReviewRequest.findByIdAndUpdate(reviewId, { status: "responded_positive", response: "neutral" });
                const { startOfDay } = require("date-fns");
                await DailyStat.findOneAndUpdate(
                    { clientId: req.clientConfig.clientId, date: startOfDay(new Date()) },
                    { $inc: { reviewsCollected: 1 } },
                    { upsert: true }
                );
                const reviewUrl = nicheData.googleReviewUrl || req.clientConfig.googleReviewUrl || "";
                const replyText = reviewUrl
                    ? `Thanks for the feedback! 😊 If you have a moment, a quick review would help a lot:\n\n${reviewUrl}`
                    : "Thanks for your feedback! 😊 We'll keep improving!";
                await sendWhatsAppText({ ...helperParams, to: from, body: replyText });
                return res.status(200).end();
            }

            if (interactiveId.startsWith('rv_bad_')) {
                const reviewId = interactiveId.replace("rv_bad_", "");
                await ReviewRequest.findByIdAndUpdate(reviewId, { status: "responded_negative", response: "negative" });
                const { startOfDay } = require("date-fns");
                await DailyStat.findOneAndUpdate(
                    { clientId: req.clientConfig.clientId, date: startOfDay(new Date()) },
                    { $inc: { reviewsCollected: 1, reviewsNegative: 1 } },
                    { upsert: true }
                );
                conversation.status = 'HUMAN_TAKEOVER';
                conversation.requiresAttention = true;
                conversation.attentionReason = "Negative review — needs follow-up";
                await conversation.save();
                if (io) io.to(`client_${req.clientConfig.clientId}`).emit("attention_required", {
                    phone: from,
                    reason: "Customer unhappy with product",
                    priority: "high"
                });
                await sendWhatsAppText({ ...helperParams, to: from, body: "We're really sorry to hear that 😔 Our team will reach out within a few hours to make it right. Your satisfaction is our priority! 💙" });
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
                Knowledge Base: ${JSON.stringify(nicheData.products || {})}
                User Message: ${userMsg}
                Instruction: Reply politely, professionally, and concisely in under 60 words. If they want to shop or see products, tell them to type 'menu'.`;

                try {
                    // Use standard v1 endpoint and gemini-1.5-flash
                    let resp;
                    try {
                        resp = await axios.post(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${req.clientConfig.geminiApiKey}`, {
                            contents: [{ parts: [{ text: prompt }] }]
                        });
                    } catch (axiosErr) {
                        console.error('[EcommerceEngine] Flash failed, falling back to Pro:', axiosErr.message);
                        resp = await axios.post(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-pro:generateContent?key=${req.clientConfig.geminiApiKey}`, {
                            contents: [{ parts: [{ text: prompt }] }]
                        });
                    }
                    const aiText = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (aiText) await sendWhatsAppText({ ...helperParams, to: from, body: aiText });
                } catch (e) { 
                    console.error('[EcommerceEngine] AI FATAL Error:', e.response?.data || e.message); 
                }
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

        if (isCOD && req.clientConfig.razorpayKeyId) {
            const codFlow = (req.clientConfig.automationFlows || []).find(f => f.id === "cod_to_prepaid");
            const isActive = codFlow?.isActive ?? false;

            if (isActive) {
                const delayMs = (codFlow?.config?.delayMinutes || 3) * 60 * 1000;
                setTimeout(async () => {
                    try {
                        const refreshedClient = await require('../../models/Client').findOne({ clientId });
                        await sendCODToPrepaidNudge(savedOrder, refreshedClient, phone);
                    } catch (err) {
                        console.error("[EcommerceEngine] COD nudge failed:", err.message);
                    }
                }, delayMs);
            }
        }

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


const handleShopifyOrderFulfilledWebhook = async (req, res) => {
    res.status(200).end(); // Always respond 200 first for Shopify
    try {
        const { clientId } = req.clientConfig;
        const payload = req.body;
        const phoneRaw = payload.phone || payload.customer?.phone || payload.billing_address?.phone || payload.shipping_address?.phone;
        if (!phoneRaw) return;
        const phone = phoneRaw.replace(/\D/g, "");

        const orderNumber = payload.order_number || payload.name;
        const productName = payload.line_items?.[0]?.title || "your product";
        const trackingUrl = payload.fulfillments?.[0]?.tracking_url || "";
        const trackingNum = payload.fulfillments?.[0]?.tracking_number || "";

        await Order.findOneAndUpdate(
            { shopifyOrderId: String(payload.id), clientId },
            { status: "fulfilled", fulfilledAt: new Date(), trackingUrl, trackingNumber: trackingNum }
        );

        const shippingMsg = `📦 Your order #${orderNumber} has been shipped!\n\n` +
            (trackingUrl ? `🚚 Track here: ${trackingUrl}\n\n` : "") +
            `Expected delivery in 3-5 business days. We'll keep you posted!`;

        const helperParams = { phoneNumberId: req.clientConfig.phoneNumberId, token: req.clientConfig.whatsappToken, io: req.app.get('socketio'), clientConfig: req.clientConfig };
        await sendWhatsAppText({ ...helperParams, to: phone, body: shippingMsg });

        const reviewFlow = (req.clientConfig.automationFlows || []).find(f => f.id === "review_collection");
        if (reviewFlow?.isActive) {
            const delayDays = reviewFlow?.config?.delayDays || 4;
            const scheduledFor = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000);
            await ReviewRequest.findOneAndUpdate(
                { clientId: req.clientConfig._id, phone, orderNumber },
                {
                    clientId: req.clientConfig._id, phone, orderNumber, productName,
                    reviewUrl: req.clientConfig.googleReviewUrl || "",
                    scheduledFor, status: "scheduled"
                },
                { upsert: true }
            );
        }
    } catch (err) {
        console.error("[EcommerceEngine] Order fulfilled error:", err);
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
    handleShopifyOrderFulfilledWebhook,
    getClientOrders,
    getCartSnapshot,
    restoreCart,
    logRestoreEvent
};
