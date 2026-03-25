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

// Helper to save message to DB and emit to Socket.IO
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
    const { from, phoneNumberId, messages } = req;
    const { clientId, whatsappToken: token, nicheData, plan } = req.clientConfig;
    const io = req.app.get('socketio');
    const helperParams = { phoneNumberId, token, io, clientId };

    const userMsgType = messages.type;
    const userMsg = userMsgType === 'interactive' ? 
        (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id) : 
        messages.text?.body;

    // --- DB Logging & State Management ---
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

            // Create Appointment
            const appointment = await Appointment.create({
                clientId, phone: from, name: customer_name,
                service: serviceLabel, date, time: timeId,
                status: 'confirmed', source: 'chatbot_flow'
            });

            // GCal Sync
            const startTime = DateTime.fromISO(`${date}T${timeId.replace('_', ':')}:00`, { zone: 'Asia/Kolkata' }).toISO();
            const endTime = DateTime.fromISO(startTime).plus({ minutes: nicheData.slotDuration || 60 }).toISO();
            
            await createEvent(calendarId, {
                summary: `Booking: ${customer_name}`,
                description: `Service: ${serviceLabel}\nPhone: ${from}`,
                startTime, endTime
            });

            // Confirmation
            await sendWhatsAppText({
                ...helperParams, to: from,
                body: `✅ *Booking Confirmed!*\n\n👤 *Name:* ${customer_name}\n💇‍♀️ *Service:* ${serviceLabel}\n📅 *Date:* ${date}\n🕒 *Time:* ${timeId.replace('_', ' ')}\n\nSee you soon! ✨`
            });

            return res.status(200).end();
        } catch (err) {
            console.error('[GenericEngine] Flow error:', err);
            return res.status(200).end();
        }
    }

    // 2. Handle Greeting / Trigger
    const greetings = ['hi', 'hello', 'hey', 'namaste', 'kem cho'];
    if (greetings.includes(userMsg?.toLowerCase())) {
        const welcomeMsg = nicheData.welcomeMessage || 'Welcome! How can we help you today?';
        const welcomeImg = nicheData.bannerImage;

        await sendWhatsAppButtons({
            ...helperParams, to: from, imageHeader: welcomeImg,
            body: welcomeMsg,
            buttons: [
                { id: 'user_book', title: 'Book Now 📅' },
                { id: 'user_faq', title: 'Ask a Question ❓' }
            ]
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
        await sendWhatsAppText({
            ...helperParams, to: from,
            body: 'Sure! 😊 What would you like to know? Feel free to ask me anything about our services, pricing, or hours!'
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
