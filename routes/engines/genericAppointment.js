const express = require('express');
const axios = require('axios');
const { DateTime } = require('luxon');
const Appointment = require('../../models/Appointment');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Client = require('../../models/Client');
const { createEvent } = require('../../utils/googleCalendar');
const { getAvailableSlots } = require('../../utils/getAvailableSlots');
const { decryptFlowData, encryptFlowResponse } = require('../../utils/flowEncryption');

/**
 * Universal Appointment Engine
 * Handles dynamic booking flows for Salons, Clinics, and other slot-based niches.
 * Driven by client.nicheData and client.plan.
 */

// --- 1. VISUAL FLOW ENGINE ---
async function findNextNode(currentNodeId, handleId, edges) {
    console.log(`[AppointmentFlow] Finding path from ${currentNodeId} with handle: ${handleId}`);
    // Prioritize sourceHandle match, fallback to match button text if handleId is missing
    let edge = edges.find(e => e.source === currentNodeId && (handleId ? e.sourceHandle === handleId : true));
    
    if (!edge && handleId) {
        // Fallback: match by handle label if handle ID is missing (v1 -> v2 migration support)
        edge = edges.find(e => e.source === currentNodeId && e.label === handleId);
    }
    
    if (!edge) {
         const fallbackEdge = edges.find(e => e.source === currentNodeId);
         if (fallbackEdge && !handleId) return fallbackEdge.target;
    }
    return edge ? edge.target : null;
}

async function executeNode({ nodeId, nodes, edges, to, phoneNumberId, io, clientConfig }) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    console.log(`[AppointmentFlow] Executing Node: ${node.id} (${node.type})`);

    // Update conversation's current step
    await Conversation.findOneAndUpdate({ phone: to, clientId: clientConfig.clientId }, { lastStepId: node.id });

    if (node.type === 'message') {
        const { text, imageUrl } = node.data;
        if (imageUrl) {
            await sendWhatsAppImage({ phoneNumberId, to, imageUrl, caption: text, io, clientConfig });
        } else {
            await sendWhatsAppText({ phoneNumberId, to, body: text, io, clientConfig });
        }
        // Auto-traverse
        const nextNodeId = await findNextNode(node.id, null, edges);
        if (nextNodeId) await executeNode({ nodeId: nextNodeId, nodes, edges, to, phoneNumberId, io, clientConfig });
    } 
    else if (node.type === 'interactive') {
        const { text, buttonsList = [], buttons, imageUrl, header, footer } = node.data;
        const finalButtons = Array.isArray(buttonsList) && buttonsList.length > 0
            ? buttonsList 
            : (buttons || '').split(',').map(b => b.trim()).filter(Boolean).map(b => ({ id: b.toLowerCase().replace(/\s+/g, '_'), title: b }));

        if (finalButtons.length === 0) {
            await sendWhatsAppText({ phoneNumberId, to, body: text, io, clientConfig });
            return;
        }

        const interactive = {
            type: 'button',
            action: {
                buttons: finalButtons.slice(0, 3).map((btn, i) => ({
                    type: 'reply',
                    reply: { 
                        id: btn.id || `btn_${i}`, 
                        title: (btn.title || 'Click').substring(0, 20) 
                    }
                }))
            }
        };
        if (imageUrl) interactive.header = { type: 'image', image: { link: imageUrl } };
        else if (header) interactive.header = { type: 'text', text: header.substring(0, 60) };
        if (footer) interactive.footer = { type: 'text', text: footer.substring(0, 60) };

        await sendWhatsAppInteractive({
            phoneNumberId, to, body: text || 'Select an option:', interactive, io, clientConfig
        });
    }
    else if (node.type === 'template') {
        const { templateName, headerImageUrl } = node.data;
        await sendWhatsAppTemplate({
            phoneNumberId, to, templateName, headerImageUrl, io, clientConfig
        });
        // Auto-traverse to next (or wait for webhook if branching)
    }
}

// --- 2. CORE API WRAPPERS ---
async function saveAndEmitMessage({ clientId, from, to, body, type, direction, status, conversationId, io }) {
    try {
        const savedMessage = await Message.create({
            clientId,
            conversationId,
            from,
            to,
            content: body,
            type,
            direction,
            status,
            timestamp: new Date()
        });

        if (io) {
            io.to(`client_${clientId}`).emit('new_message', savedMessage);
        }
        return savedMessage;
    } catch (err) {
        console.error('[GenericEngine] Error saving message:', err);
        return null;
    }
}

async function sendWhatsAppText({ phoneNumberId, to, body, token, io, clientId }) {
    const apiVersion = process.env.API_VERSION || 'v18.0';
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

        let conversation = await Conversation.findOne({ phone: to, clientId });
        if (!conversation) {
            conversation = await Conversation.create({ phone: to, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
        }
        conversation.lastMessage = body;
        conversation.lastMessageAt = new Date();
        await conversation.save();

        if (io) io.to(`client_${clientId}`).emit('conversation_update', conversation);

        await saveAndEmitMessage({
            clientId, from: 'bot', to, body, type: 'text', direction: 'outgoing',
            status: 'sent', conversationId: conversation._id, io
        });
    } catch (err) {
        console.error('[GenericEngine] Error sending text:', err.response?.data || err.message);
    }
}

async function sendWhatsAppInteractive({ phoneNumberId, to, body, interactive, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    const sanitizedBody = (body || 'Choose an option:').substring(0, 1024);
    const sanitizedAction = { ...interactive.action };
    
    if (sanitizedAction.buttons) {
        const seenIds = new Set();
        sanitizedAction.buttons = sanitizedAction.buttons.map((b, i) => {
            let id = (b.reply?.id || `btn_${i}`).substring(0, 256);
            if (seenIds.has(id)) id = `${id}_${i}`;
            seenIds.add(id);
            return {
                ...b,
                reply: { id, title: (b.reply?.title || 'Click').substring(0, 20) }
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
        data.interactive.footer = { type: 'text', text: interactive.footer.text.substring(0, 60) };
    }

    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, data, { headers: { Authorization: `Bearer ${token}` } });
        await saveAndEmitMessage({ clientId: clientConfig.clientId, from: 'bot', to, body: `[Interactive] ${sanitizedBody}`, type: 'interactive', direction: 'outgoing', status: 'sent', conversationId: (await Conversation.findOne({ phone: to, clientId: clientConfig.clientId }))?._id, io });
        return true;
    } catch (err) { 
        console.error('[GenericEngine] Interactive Error:', JSON.stringify(err.response?.data || err.message)); 
        return false; 
    }
}

async function sendWhatsAppButtons({ phoneNumberId, to, header, body, buttons, token, io, clientId, footer, imageHeader }) {
    const apiVersion = process.env.API_VERSION || 'v18.0';
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            header: imageHeader ? { type: 'image', image: { link: imageHeader } } : (header ? { type: 'text', text: header } : undefined),
            body: { text: body },
            footer: footer ? { text: footer } : undefined,
            action: {
                buttons: buttons.map(({ id, title }) => ({
                    type: 'reply',
                    reply: { id, title }
                }))
            }
        }
    };
    if (!header && !imageHeader) delete data.interactive.header;
    try {
        await axios.post(url, data, {
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
        });

        let conversation = await Conversation.findOne({ phone: to, clientId });
        if (!conversation) {
            conversation = await Conversation.create({ phone: to, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
        }
        conversation.lastMessage = body;
        conversation.lastMessageAt = new Date();
        await conversation.save();

        if (io) io.to(`client_${clientId}`).emit('conversation_update', conversation);

        await saveAndEmitMessage({
            clientId, from: 'bot', to, body, type: 'interactive', direction: 'outgoing',
            status: 'sent', conversationId: conversation._id, io
        });
    } catch (err) {
        console.error('[GenericEngine] Error sending buttons:', err.response?.data || err.message);
    }
}

async function sendWhatsAppTemplate({ phoneNumberId, to, templateName, languageCode = 'en', headerImageUrl = null, bodyParams = [], buttonUrlParam = null, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    const apiVersion = process.env.API_VERSION || 'v18.0';
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

        await axios.post(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
            messaging_product: 'whatsapp', to, type: 'template', template: templateData
        }, { headers: { Authorization: `Bearer ${token}` } });
        
        let conversation = await Conversation.findOne({ phone: to, clientId: clientConfig.clientId });
        if (!conversation) conversation = await Conversation.create({ phone: to, clientId: clientConfig.clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
        
        await saveAndEmitMessage({ clientId: clientConfig.clientId, from: 'bot', to, body: `[Template] ${templateName}`, type: 'template', direction: 'outgoing', status: 'sent', conversationId: conversation._id, io });
        return true;
    } catch (err) { 
        console.error('[GenericEngine] Template Error:', err.response?.data || err.message); 
        return false; 
    }
}

async function sendDynamicMessage({ stepId, fallbackInteractive, phoneNumberId, to, io, clientConfig, templateParams = {} }) {
    const mappedTpl = (clientConfig.messageTemplates || []).find(t => t.id === stepId);
    const token = clientConfig.whatsappToken;
    
    if (mappedTpl && mappedTpl.type === 'meta_template' && mappedTpl.templateName) {
        let bodyParams = templateParams.variables || [];
        let buttonUrlParam = templateParams.buttonUrlParam || to; // Fallback to Phone Number (uid)

        const success = await sendWhatsAppTemplate({
            phoneNumberId, to, io, clientConfig,
            templateName: mappedTpl.templateName,
            headerImageUrl: mappedTpl.headerImage || null,
            bodyParams,
            buttonUrlParam,
            languageCode: 'en'
        });
        if (success) return true;
        console.warn(`[GenericEngine] Meta template ${mappedTpl.templateName} failed. Falling back to interactive.`);
    }

    if (fallbackInteractive.type === 'interactive') {
        const { header, body, buttons, imageHeader } = fallbackInteractive.interactive;
        return await sendWhatsAppButtons({
            phoneNumberId, to, io, clientId: clientConfig.clientId, token,
            header, body, buttons, imageHeader
        });
    } else if (fallbackInteractive.type === 'text') {
        return await sendWhatsAppText({
            phoneNumberId, to, io, clientId: clientConfig.clientId, token,
            body: fallbackInteractive.body
        });
    }
}

async function sendWhatsAppFlow({ phoneNumberId, to, header, body, token, io, clientId, flowId, screenId, footer }) {
    const apiVersion = process.env.API_VERSION || 'v18.0';
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'flow',
            header: { type: 'text', text: header || 'Book Now' },
            body: { text: body || 'Tap below to open our booking form.' },
            footer: { text: footer || 'Powered by TopEdge AI' },
            action: {
                name: 'flow',
                parameters: {
                    flow_message_version: '3',
                    flow_token: `${clientId}_flow`,
                    flow_id: flowId,
                    flow_cta: 'Book Now',
                    flow_action: 'navigate',
                    flow_action_payload: { screen: screenId }
                }
            }
        }
    };
    try {
        await axios.post(url, data, {
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
        });

        let conversation = await Conversation.findOne({ phone: to, clientId });
        if (!conversation) {
            conversation = await Conversation.create({ phone: to, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
        }
        conversation.lastMessage = 'Sent Booking Flow';
        conversation.lastMessageAt = new Date();
        await conversation.save();

        await saveAndEmitMessage({
            clientId, from: 'bot', to, body: 'Sent Booking Flow', type: 'interactive', direction: 'outgoing',
            status: 'sent', conversationId: conversation._id, io
        });
    } catch (err) {
        console.error('[GenericEngine] Error sending flow:', err.response?.data || err.message);
    }
}

const handleWebhook = async (req, res) => {
    const { from, phoneNumberId, messages } = req.body;
    const { clientId, whatsappToken: token, nicheData, flowNodes, flowEdges, plan } = req.clientConfig;
    const io = req.app.get('socketio');
    const helperParams = { phoneNumberId, token, io, clientId };

    const userMsgType = messages.type;
    const userMsg = userMsgType === 'interactive' 
        ? (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id) 
        : messages.text?.body;

    console.log(`[AppointmentEngine] Incoming from ${from} (${userMsgType}): ${userMsg}`);

    // --- 1. VISUAL FLOW TRAVERSAL ---
    if (flowNodes && flowNodes.length > 0) {
        // Find if user is in an existing flow
        const conversation = await Conversation.findOne({ phone: from, clientId });
        const lastStepId = conversation?.lastStepId;

        if (userMsgType === 'interactive') {
            const nextNodeId = await findNextNode(lastStepId, userMsg, flowEdges || []);
            if (nextNodeId) {
                await executeNode({ nodeId: nextNodeId, nodes: flowNodes, edges: flowEdges || [], to: from, phoneNumberId, io, clientConfig: req.clientConfig });
                return res.status(200).end();
            }
        }

        // Check for Trigger (Keywords)
        const triggerNode = flowNodes.find(n => n.type === 'trigger' && n.data?.trigger?.keyword?.toLowerCase() === userMsg?.toLowerCase());
        if (triggerNode) {
            await executeNode({ nodeId: triggerNode.id, nodes: flowNodes, edges: flowEdges || [], to: from, phoneNumberId, io, clientConfig: req.clientConfig });
            return res.status(200).end();
        }
    }
    let conversation = await Conversation.findOne({ phone: from, clientId });
    if (!conversation) {
        conversation = await Conversation.create({ phone: from, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
    }

    const incomingContent =
        userMsgType === 'text' ? messages.text?.body :
        userMsgType === 'interactive' && messages.interactive.type === 'button_reply' ? messages.interactive.button_reply.title :
        userMsgType === 'interactive' && messages.interactive.type === 'list_reply' ? messages.interactive.list_reply.title :
        userMsgType === 'interactive' && messages.interactive.type === 'nfm_reply' ? 'Flow Submission' :
        `[${userMsgType}]`;

    const savedMsg = await Message.create({
        clientId,
        conversationId: conversation._id,
        from,
        to: 'bot',
        content: incomingContent,
        type: userMsgType,
        direction: 'incoming',
        messageId: messages.id,
        status: 'received',
        timestamp: new Date()
    });

    conversation.lastMessage = incomingContent;
    conversation.lastMessageAt = new Date();
    if (conversation.status === 'HUMAN_TAKEOVER') {
        conversation.unreadCount = (conversation.unreadCount || 0) + 1;
    }
    await conversation.save();

    if (io) {
        io.to(`client_${clientId}`).emit('new_message', savedMsg);
        io.to(`client_${clientId}`).emit('conversation_update', conversation);
    }

    if (conversation.status === 'HUMAN_TAKEOVER') {
        console.log(`[GenericEngine] Human Takeover active for ${from}, skipping bot logic.`);
        return res.status(200).end();
    }
    // --- End DB Logging ---

    // 1. Handle Meta Flow Response (V2 Feature)
    if (userMsgType === 'interactive' && messages.interactive?.type === 'nfm_reply' && plan === 'CX Agent (V2)') {
        try {
            const responseJson = JSON.parse(messages.interactive.nfm_reply.response_json);
            const { service: serviceId, date, time: timeId, customer_name } = responseJson;

            // Resolve service name from nicheData
            const services = nicheData.services || [];
            const foundService = services.find(s => s.id === serviceId);
            const serviceLabel = foundService ? `${foundService.title} (${foundService.price})` : serviceId;

            // Verification Bridge: Check if slot is still available
            const calendars = nicheData.calendars || {};
            const staffKey = responseJson.staff || 'default';
            const calendarId = calendars[staffKey] || req.clientConfig.googleCalendarId;

            const slotResult = await getAvailableSlots(date, 0, calendarId, nicheData);
            const isAvailable = slotResult.slots.some(s => s.id === timeId || s.title === timeId);

            if (!isAvailable) {
                await sendWhatsAppFlow({
                    ...helperParams, to: from,
                    flowId: nicheData.flowId, screenId: nicheData.screenId,
                    body: 'Sorry! That slot just got booked. Please pick another time!'
                });
                return res.status(200).end();
            }

            // Create Pending Appointment
            const appointment = await Appointment.create({
                clientId, phone: from, name: customer_name,
                service: serviceLabel, date, time: timeId,
                status: 'pending', source: 'chatbot_flow'
            });

            // Pending Confirmation Buttons
            const confirmMsg = `Almost there, ${customer_name}! ✨\n\nPlease confirm your details:\n\n💇‍♀️ *Service:* ${serviceLabel}\n📅 *Date:* ${date}\n🕒 *Time:* ${timeId.replace('_', ' ')}\n\nTap confirm below to finalize your booking!`;
            
            await sendWhatsAppButtons({
                ...helperParams, to: from,
                body: confirmMsg,
                buttons: [
                    { id: `confirm_apt_${appointment._id}`, title: '✅ Confirm Booking' },
                    { id: `cancel_apt_${appointment._id}`, title: '❌ Cancel' }
                ]
            });

            return res.status(200).end();

            return res.status(200).end();
        } catch (err) {
            console.error('[GenericEngine] Flow error:', err);
            return res.status(200).end();
        }
    }

    // --- Interactive Button Handlers (Confirmation Flow) ---
    if (userMsgType === 'interactive' && userMsg.startsWith('confirm_apt_')) {
        const aptId = userMsg.replace('confirm_apt_', '');
        try {
            const appointment = await Appointment.findById(aptId);
            if (!appointment) return res.status(200).end();
            if (appointment.status === 'confirmed') {
                await sendWhatsAppText({ ...helperParams, to: from, body: 'Thanks! This booking has already been confirmed. See you soon! ✨' });
                return res.status(200).end();
            }

            appointment.status = 'confirmed';
            await appointment.save();

            // GCal Sync
            const calendars = nicheData.calendars || {};
            const staffKey = 'default'; 
            const calendarId = calendars[staffKey] || req.clientConfig.googleCalendarId;

            const startTime = DateTime.fromISO(`${appointment.date}T${appointment.time.replace('_', ':')}:00`, { zone: 'Asia/Kolkata' }).toISO();
            const endTime = DateTime.fromISO(startTime).plus({ minutes: nicheData.slotDuration || 60 }).toISO();
            
            await createEvent(calendarId, {
                summary: `Booking: ${appointment.name}`,
                description: `Service: ${appointment.service}\nPhone: ${from}`,
                startTime, endTime
            });

            // Final Confirmation via Dynamic Message
            const fallbackBody = `✅ *Booking Confirmed!*\n\n👤 *Name:* ${appointment.name}\n💇‍♀️ *Service:* ${appointment.service}\n📅 *Date:* ${appointment.date}\n🕒 *Time:* ${appointment.time.replace('_', ' ')}\n\nSee you soon! ✨`;
            await sendDynamicMessage({
                stepId: 'order_confirmation',
                fallbackInteractive: { type: 'text', body: fallbackBody },
                phoneNumberId: helperParams.phoneNumberId,
                to: from,
                io: helperParams.io,
                clientConfig: req.clientConfig,
                templateParams: { variables: [appointment.name, appointment.service, appointment.date, appointment.time.replace('_', ' ')] }
            });

            return res.status(200).end();
        } catch (err) {
            console.error('[GenericEngine] Confirm Error:', err);
            return res.status(200).end();
        }
    }

    if (userMsgType === 'interactive' && userMsg.startsWith('cancel_apt_')) {
        const aptId = userMsg.replace('cancel_apt_', '');
        await Appointment.findByIdAndUpdate(aptId, { status: 'cancelled' });
        await sendWhatsAppText({ ...helperParams, to: from, body: 'No problem! Your booking has been cancelled. Let us know if you need anything else! 😊' });
        return res.status(200).end();
    }

    // 2. Handle Greeting / Trigger
    const greetings = ['hi', 'hello', 'hey', 'namaste', 'kem cho'];
    if (greetings.includes(userMsg?.toLowerCase())) {
        const welcomeMsg = nicheData.welcomeMessage || 'Welcome! How can we help you today?';
        const welcomeImg = nicheData.bannerImage;

        await sendDynamicMessage({
            stepId: 'welcome_menu',
            fallbackInteractive: { 
                type: 'interactive', 
                body: welcomeMsg, 
                interactive: {
                    imageHeader: welcomeImg,
                    body: welcomeMsg,
                    buttons: [
                        { id: 'user_book', title: 'Book Now 📅' },
                        { id: 'user_faq', title: 'Ask a Question ❓' }
                    ]
                }
            },
            phoneNumberId: helperParams.phoneNumberId,
            to: from,
            io: helperParams.io,
            clientConfig: req.clientConfig
        });
        return res.status(200).end();
    }

    // 3. Handle "Book Now" Button
    if (userMsg === 'user_book') {
        if (plan === 'CX Agent (V2)' && nicheData.flowId) {
            await sendWhatsAppFlow({
                ...helperParams, to: from,
                flowId: nicheData.flowId,
                screenId: nicheData.screenId || 'BOOKING_SCREEN'
            });
        } else {
            // Fallback for V1
            await sendWhatsAppText({
                ...helperParams, to: from,
                body: `To book an appointment, please call us directly at ${req.clientConfig.adminPhoneNumber || 'our front desk'}.`
            });
        }
        return res.status(200).end();
    }

    // 4. Handle "Ask a Question" Button
    if (userMsg === 'user_faq') {
        await sendDynamicMessage({
            stepId: 'support_menu',
            fallbackInteractive: { type: 'text', body: 'Sure! 😊 What would you like to know? Feel free to ask me anything about our services, pricing, or hours!' },
            phoneNumberId: helperParams.phoneNumberId,
            to: from,
            io: helperParams.io,
            clientConfig: req.clientConfig
        });
        return res.status(200).end();
    }

    // 5. AI Fallback for Free Text
    if (userMsgType === 'text') {
        // AI Fallback using Gemini
        const geminiKey = req.clientConfig.geminiApiKey;
        const aiPromptContext = nicheData.aiPrompt || 'You are a helpful assistant for a local business. Use the knowledge base to answer questions.';
        const knowledgeBase = nicheData.knowledgeBase || JSON.stringify(nicheData.services || []);

        if (!geminiKey) {
            await sendWhatsAppText({
                ...helperParams, to: from,
                body: 'Our AI system is currently being configured. Please call us for immediate assistance.'
            });
            return res.status(200).end();
        }

        const prompt = `${aiPromptContext}
        
KNOWLEDGE BASE:
${knowledgeBase}

USER QUESTION: ${userMsg}

Please provide a helpful, human-like response. If the answer isn't in the knowledge base, ask them to use the Book Now button or contact the admin. Keep it very short and conversational!`;

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
            const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
            const resp = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
            let aiResponse = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'I am not sure how to answer that right now.';
            
            await sendWhatsAppButtons({
                ...helperParams, to: from,
                body: aiResponse.trim(),
                buttons: [
                    { id: 'user_book', title: 'Book Now 📅' },
                    { id: 'user_faq', title: 'Ask another ❓' }
                ]
            });
        } catch (err) {
            console.error('[GenericEngine] Gemini API Error:', err.message);
            await sendWhatsAppText({
                ...helperParams, to: from,
                body: "I'm having trouble accessing information right now. Please try again later."
            });
        }
        return res.status(200).end();
    }

    res.status(200).end();
};

const handleFlowWebhook = async (req, res) => {
    try {
        const { decryptedBody, aesKey, iv, algorithm } = decryptFlowData(req.body);
        const { nicheData, googleCalendarId } = req.clientConfig;

        console.log(`[GenericFlow] Client: ${req.clientConfig.clientId}, Action: ${decryptedBody.action}`);

        let responsePayload = {};

        switch (decryptedBody.action) {
            case 'ping':
                responsePayload = { data: { status: "active" } };
                break;

            case 'INIT':
                responsePayload = {
                    screen: nicheData.screenId || "BOOKING_SCREEN",
                    data: {
                        services: (nicheData.services || []).map(s => ({ id: s.id, title: s.title }))
                    }
                };
                break;

            case 'data_exchange': {
                const date = decryptedBody.data?.selected_date || new Date().toISOString().split('T')[0];
                const staffKey = decryptedBody.data?.staff || 'default';
                const calendars = nicheData.calendars || {};
                const calendarId = calendars[staffKey] || googleCalendarId;

                console.log(`[GenericFlow] Fetching slots for ${date} on calendar ${calendarId}`);

                // Fetch ALL available slots (handle pagination internally)
                let allFormattedSlots = [];
                let currentPage = 0;
                let hasMore = true;

                while (hasMore && currentPage < 5) {
                    const result = await getAvailableSlots(date, currentPage, calendarId, nicheData);
                    const pageSlots = result.slots.filter(s => s.slot).map(s => ({
                        id: s.slot.startTime.replace(':', '_'), // ID used in flow
                        title: s.title // Label
                    }));
                    
                    allFormattedSlots.push(...pageSlots);
                    hasMore = result.hasMore;
                    currentPage++;
                }

                responsePayload = {
                    screen: nicheData.nextScreenId || "TIME_AND_DETAILS_SCREEN",
                    data: {
                        selected_service: decryptedBody.data?.service,
                        selected_date: date,
                        available_slots: allFormattedSlots.length > 0 ? allFormattedSlots : [{ id: 'none', title: 'No slots' }]
                    }
                };
                break;
            }

            default:
                responsePayload = { screen: nicheData.screenId || "BOOKING_SCREEN", data: {} };
                break;
        }

        const encryptedResponse = encryptFlowResponse(responsePayload, aesKey, iv, algorithm);
        res.status(200).set('Content-Type', 'text/plain').send(encryptedResponse);

    } catch (err) {
        console.error('[GenericFlow] Critical error:', err.message);
        res.status(500).send('Flow Error');
    }
};

module.exports = { handleWebhook, handleFlowWebhook };
