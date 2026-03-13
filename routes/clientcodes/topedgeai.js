const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');

dotenv.config();

// --- API WRAPPERS ---

async function sendWhatsAppText({ phoneNumberId, to, body, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body, preview_url: true }
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
            clientConfig
        });
        return true;
    } catch (err) { console.error('Interactive Error:', err.message); return false; }
}

async function sendWhatsAppFlow({ phoneNumberId, to, flowId, body, buttonText = 'Open Form', io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'flow',
            header: { type: 'text', text: 'TopEdge AI Demo' },
            body: { text: body },
            footer: { text: 'Automated Booking Flow' },
            action: {
                name: 'flow',
                parameters: {
                    flow_message_version: '3',
                    flow_token: 'topedge_demo_token',
                    flow_id: flowId,
                    flow_cta: buttonText,
                    flow_action: 'navigate',
                    flow_action_payload: { screen: 'HOME' }
                }
            }
        }
    };
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, data, { headers: { Authorization: `Bearer ${token}` } });
        await saveAndEmitMessage({ phoneNumberId, to, body: `[Flow] ${body}`, type: 'interactive', io, clientConfig });
        return true;
    } catch (err) { console.error('Flow Error:', err.message); return false; }
}

async function sendContactCard({ phoneNumberId, to, vcard, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            to,
            type: 'contacts',
            contacts: [vcard]
        }, { headers: { Authorization: `Bearer ${token}` } });
        return true;
    } catch (err) { console.error('Contact Error:', err.message); return false; }
}

async function saveAndEmitMessage({ to, body, type, io, clientConfig, from = 'bot', metadata = {} }) {
    try {
        const conversation = await Conversation.findOneAndUpdate(
            { clientId: clientConfig.clientId, phone: to },
            { $set: { lastMessage: body, lastMessageAt: new Date(), status: 'BOT_ACTIVE' } },
            { upsert: true, new: true }
        );
        const msg = await Message.create({ clientId: clientConfig.clientId, conversationId: conversation._id, from, to, content: body, type, direction: from === 'bot' ? 'outgoing' : 'incoming', status: from === 'bot' ? 'sent' : 'received', metadata });
        if (io) {
            io.to(`client_${clientConfig.clientId}`).emit('new_message', msg);
            io.to(`client_${clientConfig.clientId}`).emit('conversation_update', conversation);
        }
    } catch (err) { console.error('DB Log Error:', err.message); }
}

// --- MENUS ---

const mainMenuInteractive = {
    type: 'list',
    header: { type: 'text', text: 'TopEdge AI' },
    action: {
        button: 'Menu Options',
        sections: [{
            title: 'Select an option',
            rows: [
                { id: 'opt_chatbot', title: '🤖 Explore Chatbots', description: 'See our automated WhatsApp bots' },
                { id: 'opt_caller', title: '📞 Explore AI Caller', description: 'Experience live voice AI' },
                { id: 'opt_roi', title: '🧮 Calculate ROI', description: 'See how much revenue you lose' },
                { id: 'opt_faq', title: '❓ FAQs & Pricing', description: 'Got questions? Start here.' },
                { id: 'opt_human', title: '👨‍💻 Talk to Human', description: 'Connect directly with our team' }
            ]
        }]
    }
};

const faqInteractive = {
    type: 'list',
    header: { type: 'text', text: 'TopEdge FAQs' },
    action: {
        button: 'Select Topic',
        sections: [{
            title: 'Frequently Asked Questions',
            rows: [
                { id: 'faq_pricing', title: '💰 Pricing & Packages', description: 'How much does it cost?' },
                { id: 'faq_integration', title: '🔗 Integrations', description: 'Does it work with my software?' },
                { id: 'faq_onboarding', title: '⏱️ Onboarding Time', description: 'How fast can we go live?' },
                { id: 'opt_human', title: '👨‍💻 I need a human', description: 'Skip the bot, talk to us' },
                { id: 'menu_main', title: '⬅️ Back to Menu', description: 'Return to main options' }
            ]
        }]
    }
};

const chatbotIndustryInteractive = {
    type: 'list',
    header: { type: 'text', text: 'Industry Demos' },
    action: {
        button: 'Select Industry',
        sections: [{
            title: 'Live Chatbot Demos',
            rows: [
                { id: 'demo_salon', title: '💇‍♀️ Salon Booking', description: 'Try the WhatsApp Flow Calendar' },
                { id: 'demo_turf', title: '⚽ Turf Booking', description: 'Try the slot booking Flow' },
                { id: 'demo_clinic', title: '🩺 Clinic Booking', description: 'Try the patient intake Flow' },
                { id: 'demo_ecom', title: '🛒 E-Commerce & Retail', description: 'See our live client deployments' },
                { id: 'menu_main', title: '⬅️ Back to Menu', description: 'Return to main options' }
            ]
        }]
    }
};

// --- CORE WEBHOOK HANDLER ---

const handleWebhook = async (req, res) => {
    try {
        const body = req.body;
        if (!body.object || !body.entry?.[0]?.changes?.[0]?.value) return res.sendStatus(200);

        const value = body.entry[0].changes[0].value;
        if (!value.messages?.[0]) return res.sendStatus(200);

        const msg = value.messages[0];
        const contact = value.contacts?.[0];
        const userPhone = msg.from;
        const userName = contact?.profile?.name || 'Guest';
        const clientConfig = req.clientConfig;
        const io = req.app.get('socketio');
        const phoneId = clientConfig.phoneNumberId;

        // Ensure lead exists
        let lead = await AdLead.findOne({ phoneNumber: userPhone, clientId: clientConfig.clientId });
        if (!lead) {
            lead = await AdLead.create({
                clientId: clientConfig.clientId,
                phoneNumber: userPhone,
                name: userName,
                source: 'WhatsApp Organic',
                chatSummary: 'Started TopEdge AI session',
                meta: { roiStep: 0 }
            });
        }
        
        let incomingText = '';
        if (msg.type === 'text') {
            incomingText = msg.text.body;
        } else if (msg.type === 'interactive') {
            incomingText = msg.interactive.list_reply?.id || msg.interactive.button_reply?.id;
        }

        await saveAndEmitMessage({ to: userPhone, body: msg.type === 'text' ? incomingText : `[Interaction: ${incomingText}]`, type: msg.type, io, clientConfig, from: userPhone });

        // -- 1. ROI CALCULATOR STATE MACHINE --
        if (lead.meta && lead.meta.roiStep > 0 && msg.type === 'text') {
            const num = parseInt(incomingText.replace(/[^0-9]/g, ''), 10);
            
            if (isNaN(num)) {
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "Please enter a valid number.", io, clientConfig });
                return res.sendStatus(200);
            }

            if (lead.meta.roiStep === 1) {
                lead.meta.roiInquiries = num;
                lead.meta.roiStep = 2;
                await lead.save();
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "Great. Out of those inquiries, what is your current *Average Close Rate %*? (e.g. 10 for 10%)", io, clientConfig });
                return res.sendStatus(200);
            }
            if (lead.meta.roiStep === 2) {
                lead.meta.roiCloseRate = num;
                lead.meta.roiStep = 3;
                await lead.save();
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "Finally, what is the *Average Ticket Size* or value of one customer in ₹?", io, clientConfig });
                return res.sendStatus(200);
            }
            if (lead.meta.roiStep === 3) {
                const I = lead.meta.roiInquiries || 100;
                const C = lead.meta.roiCloseRate || 10;
                const V = num; // Average value
                
                // Agency Logic: Automating follow-ups and instantly capturing abandoned leads usually boosts total closes by 15-20% absolute, or double relative.
                // Let's assume a realistic boost of +15% conversion lift from speed-to-lead and abandoned cart/booking retargeting.
                const newC = C + 15; 
                
                const currentRev = Math.round(I * (C / 100) * V);
                const projectedRev = Math.round(I * (newC / 100) * V);
                const extraRev = projectedRev - currentRev;

                const roiMsg = `📊 *Your Business Snapshot*\n- Monthly Inquiries: \`${I}\`\n- Current Close Rate: \`${C}%\`\n- Current Revenue: \`₹${currentRev.toLocaleString()}\`/mo\n\n🚀 *With TopEdge AI Automation:*\nResearch shows businesses lose ~40% of leads from slow replies or no follow-ups. By deploying an AI that replies instantly 24/7 and automatically retargets abandoned leads, you can easily boost your close rate by a minimum of *+15%*.\n\n- Projected Close Rate: \`${newC}%\`\n- *New Projected Revenue: ₹${projectedRev.toLocaleString()}/mo*\n\n🔥 *That's an extra ₹${extraRev.toLocaleString()} every single month, on autopilot!*`;
                
                lead.meta.roiStep = 0; // Reset
                lead.meta.roiValue = extraRev;
                await lead.save();

                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: roiMsg, io, clientConfig });
                
                // Follow up immediately with human prompt
                setTimeout(async () => {
                    await sendWhatsAppInteractive({
                        phoneNumberId: phoneId,
                        to: userPhone,
                        body: "Stop letting revenue slip through the cracks. Would you like to consult with our team to build this for your brand?",
                        interactive: {
                            type: 'button',
                            action: {
                                buttons: [
                                    { type: 'reply', reply: { id: 'opt_human', title: 'Talk to Human' } },
                                    { type: 'reply', reply: { id: 'menu_main', title: 'Main Menu' } }
                                ]
                            }
                        },
                        io, clientConfig
                    });
                }, 1000);
                
                return res.sendStatus(200);
            }
        }

        // -- 2. MAIN MENU ROUTING --
        const textLower = incomingText.toLowerCase();
        
        if (['hi', 'hello', 'hey', 'start', 'menu', 'menu_main'].includes(textLower)) {
            // Reset state
            lead.meta = { ...lead.meta, roiStep: 0 };
            lead.humanIntervention = false;
            await lead.save();

            const greet = `Hi ${userName}! 👋 Welcome to *TopEdge AI*.\n\nWe provide advanced 24/7 WhatsApp AI Chatbots and Voice Callers helping businesses like Salons, Clinics, and E-Commerce scale and recover lost leads instantly.\n\nWhat would you like to explore today? 👇`;
            await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: greet, interactive: mainMenuInteractive, io, clientConfig });
            return res.sendStatus(200);
        }

        switch (incomingText) {
            case 'opt_chatbot':
                await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "We build tailored AI experiences for every industry. Select a live demo below to test the booking flow natively inside WhatsApp! 👇", interactive: chatbotIndustryInteractive, io, clientConfig });
                break;
            
            case 'opt_caller':
                const callerMsg = "> 🎙️ *TopEdge AI Caller*\n\nWant to hear an AI negotiate, book appointments, and answer complex questions over a real phone call?\n\nTest our Live Voice AI directly on our website. Click the link below, call the number, and try to stump it!\n\n👉 *Visit:* https://www.topedgeai.com";
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: callerMsg, io, clientConfig });
                setTimeout(async () => {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "What would you like to do next?", interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'menu_main', title: 'Main Menu' } }]}}, io, clientConfig});
                }, 2000);
                break;
            
            case 'opt_roi':
                lead.meta = { ...lead.meta, roiStep: 1 };
                await lead.save();
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "🧮 *Let's calculate how much revenue you're losing to slow response times.*\n\n1️⃣ First, *how many inquiries/leads* does your business receive per month? (Just type a number)", io, clientConfig });
                break;

            case 'opt_faq':
                await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "📚 *Frequently Asked Questions*\n\nSelect a topic below to learn more about how TopEdge AI seamlessly integrates into your business.", interactive: faqInteractive, io, clientConfig });
                break;

            case 'faq_pricing':
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "💰 *Pricing & Packages*\n\nWe offer custom-tailored solutions based on your lead volume and integration needs. \n\nOur base AI Chatbot packages start at just *₹4,999/month*, ensuring a massive ROI by recovering lost leads.\n\nWould you like a custom quote?", io, clientConfig });
                setTimeout(async () => {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "What's next?", interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'opt_human', title: 'Get Custom Quote' } }, { type: 'reply', reply: { id: 'menu_main', title: 'Main Menu' } }]}}, io, clientConfig});
                }, 1500);
                break;

            case 'faq_integration':
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "🔗 *Seamless Integrations*\n\nTopEdge AI integrates effortlessly with your existing tools! We connect directly to *Shopify, WooCommerce, Google Calendar, Zoho, HubSpot, and custom CRMs* via API.\n\nDon't have a CRM? No problem! We provide a beautiful, custom dashboard out-of-the-box.", io, clientConfig });
                setTimeout(async () => {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "Explore more:", interactive: faqInteractive, io, clientConfig });
                }, 1500);
                break;

            case 'faq_onboarding':
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "⏱️ *Lightning Fast Onboarding*\n\nOnce we gather your business knowledge, our engineering team can deploy your fully trained AI Assistant in just *3 to 5 business days*!\n\nWe handle all Meta API approvals, server hosting, and webhook scaling for you.", io, clientConfig });
                setTimeout(async () => {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "Explore more:", interactive: faqInteractive, io, clientConfig });
                }, 1500);
                break;

            case 'opt_human':
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "👨‍💻 *Connecting you to a human...*\n\nI have paused my automated responses. A TopEdge AI system architect will review this chat and reply to you directly very soon!\n\n*(If you want to restart the bot anytime, just type \"Menu\")*", io, clientConfig });
                
                const adminPhone = clientConfig.config?.adminPhoneNumber;
                if (adminPhone) {
                   const alertMsg = `🚨 *TopEdge AI Lead Alert*\n\n${userName} (+${userPhone}) requested human intervention!\n\nReview their chat in the dashboard or message them directly. 👉 https://wa.me/${userPhone}`;
                   await sendWhatsAppText({ phoneNumberId: phoneId, to: adminPhone, body: alertMsg, io, clientConfig });
                }

                lead.humanIntervention = true;
                lead.meta = { ...lead.meta, roiStep: 0 };
                await lead.save();
                break;

            case 'demo_salon':
                await sendWhatsAppFlow({ phoneNumberId: phoneId, to: userPhone, flowId: '1977238969670742', body: "💇‍♀️ *Salon Booking Demo*\n\nTest out how users can view services, pick a stylist, and choose a time slot natively.", buttonText: 'Book Salon', io, clientConfig });
                break;
            
            case 'demo_turf':
                await sendWhatsAppFlow({ phoneNumberId: phoneId, to: userPhone, flowId: '2142814969819669', body: "⚽ *Turf Booking Demo*\n\nTest how users can see available courts and book their 1-hour slots quickly.", buttonText: 'Book Turf', io, clientConfig });
                break;

            case 'demo_clinic':
                await sendWhatsAppFlow({ phoneNumberId: phoneId, to: userPhone, flowId: '1163688705769254', body: "🩺 *Clinic Booking Demo*\n\nTest how patients can complete an intake form and request a doctor consultation natively.", buttonText: 'Book Clinic', io, clientConfig });
                break;

            case 'demo_ecom':
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "🛒 *E-Commerce & Retail*\n\nWe deployed advanced abandoned-cart recovery and catalogue bots for these live clients. Feel free to message their live numbers to see the bot in action!", io, clientConfig});
                
                const vcardDeli = {
                    name: { formatted_name: "Delitech SmartHomes", first_name: "Delitech" },
                    phones: [{ phone: "+91 94297 84875", type: "WORK" }]
                };
                const vcardChoice = {
                    name: { formatted_name: "Choice Salon & Academy", first_name: "Choice" },
                    phones: [{ phone: "+91 92747 94547", type: "WORK" }]
                };
                
                await sendContactCard({ phoneNumberId: phoneId, to: userPhone, vcard: vcardDeli, io, clientConfig });
                await sendContactCard({ phoneNumberId: phoneId, to: userPhone, vcard: vcardChoice, io, clientConfig });
                
                setTimeout(async () => {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "Want to bring this to your own store?", interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'menu_main', title: 'Main Menu' } }]}}, io, clientConfig});
                }, 2000);
                break;

            default:
                if (lead.humanIntervention) {
                    // Bot is paused, ignore incoming messages. Human will handle it.
                    return res.sendStatus(200);
                }

                if (lead.meta.roiStep === 0) {
                    const confusedMsg = "I'm sorry, I didn't quite catch that! I'm an AI, so it's easiest if you use the buttons below. 👇\n\n*(If you are stuck, just click 'Talk to Human')*";
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: confusedMsg, interactive: mainMenuInteractive, io, clientConfig });
                }
                break;
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("TopEdge AI Webhook Error:", err.message);
        res.sendStatus(500);
    }
};

const handleFlowWebhook = async (req, res) => {
    // Boilerplate for handling the flow completions (echoing back a success message)
    try {
        const payload = req.body;
        if (payload.action === 'ping') {
            return res.status(200).json({ version: '3.0', data: { status: 'active' } });
        }
        if (payload.action === 'INIT') {
            return res.status(200).json({
                version: '3.0',
                screen: 'HOME',
                data: {
                    services: [
                        { id: '1', title: 'Service A', description: 'Sample Service' },
                        { id: '2', title: 'Service B', description: 'Sample Service' }
                    ]
                }
            });
        }
        if (payload.action === 'data_exchange') {
            return res.status(200).json({
                version: '3.0',
                screen: 'SUCCESS',
                data: {
                    success_message: 'Thanks for testing the TopEdge AI Flow Demo! Notice how fast and clean this experience is for your customers without ever leaving WhatsApp.'
                }
            });
        }
        res.status(200).send('OK');
    } catch (err) {
        console.error("Flow Webhook Error:", err.message);
        res.status(500).send('Internal Server Error');
    }
};

module.exports = {
    handleWebhook,
    handleFlowWebhook
};
