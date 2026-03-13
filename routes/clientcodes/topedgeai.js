const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const BotAnalytics = require('../../models/BotAnalytics');
const cron = require('node-cron');


dotenv.config();

// --- GLOBALS ---
const timerMap = new Map();
const SALON_FLOW_ID = '1977238969670742';
const TURF_FLOW_ID = '2142814969819669';
const CLINIC_FLOW_ID = '1163688705769254';
const CALL_FLOW_ID = 'YOUR_CALL_FLOW_ID'; // User to replace after creating the Flow in Meta Builder

const EVENTS = {
    SESSION_START:      'session_start',
    LANG_SELECTED:      'lang_selected',
    QUALIFIER_DONE:     'qualifier_done',
    VERTICAL_PICKED:    'vertical_picked',
    DEMO_OPENED:        'demo_opened',
    DEMO_COMPLETED:     'demo_completed',
    ROI_STARTED:        'roi_started',
    ROI_COMPLETED:      'roi_completed',
    FOLLOWUP_SENT:      'followup_sent',
    FOLLOWUP_REPLIED:   'followup_replied',
    CALL_BOOKED:        'call_booked',
    HUMAN_REQUESTED:    'human_requested',
    OPT_OUT:            'opt_out'
};

const STRINGS = {
        pricing:        `💰 See pricing`,
        tryDemo:        `👀 Try a demo`,
        connecting:     `Connecting you to our team... 👨‍💻\n\nA human agent will take over this chat shortly. The AI bot has been muted for your convenience.`,
        connectingAdmin: `I have paused my automated responses. A TopEdge AI system architect will review this chat and reply to you directly very soon!\n\n*(If you want to restart the bot anytime, just type "Menu")*`,
        validNumber:    `Please enter a valid number.`,
        pricingMsg:     `*TopEdge AI Pricing* 💰\n\n- Business Starter: ₹4,999/mo\n- Growth Pro: ₹12,999/mo\n- Enterprise Custom: From ₹25,000\n\nAll plans include 24/7 AI, full CRM integration, and 100% automated follow-ups.\n\nReady to get started? 👇`,
        discoveryCallBody: `Schedule your free 30-minute strategy session with our technical team. Pick a time that works best for you 👇`,
        discoveryCallBtn: `Book Now`,
        faqPricing:     `💰 Pricing`,
        faqIntegrations: `🔗 Integrations`,
        faqOnboarding:  `⏱️ Onboarding`,
        integrationMsg: `Our AI Chatbots and Voice Callers integrate with:\n\n✅ Shopify\n✅ Zoho CRM\n✅ Google Calendar\n✅ Custom APIs\n\nWe connect directly to your existing systems to automate data entry and follow-ups.`,
        onboardingMsg: `🚀 *Getting Started with TopEdge AI*\n\n1. Strategy Call (Today)\n2. Demo & Approval (Day 1-2)\n3. Technical Setup (Day 3-4)\n4. Live Launch (Day 5)\n\nWe build and manage everything for you.`,
        contactDelitech: `Check out our live client Delitech — they're running this right now:`,
        confirmBooking: (day, time) => `✅ Done!\nYour call is booked for ${day} at ${time} IST.`,
    },
    gu: {
        greeting:       (name) => `કેમ છો ${name}! હું TopEdge AI ડેમો બોટ છું 🤖`,
        qualifier:      `જાદુ બતાવતા પહેલા, એક નાનો પ્રશ્ન —`,
        isOwner:        `🏢 મારો વ્યવસાય છે`,
        isExplorer:     `🔍 ફક્ત જોઈ રહ્યો છું`,
        isDev:          `💼 હું ડેવલપર / એજન્સી છું`,
        whichVertical:  `તમારો વ્યવસાય કઈ શ્રેણીમાં છે?`,
        salon:          `💇‍♀️ સલૂન / સ્પા`,
        turf:           `🏟️ ટર્ફ / સ્પોર્ટ્સ`,
        clinic:         `🩺 ક્લિનિક / હેલ્થકેર`,
        ecommerce:      `🛒 ઈ-કોમર્સ / રિટેઈલ`,
        roiIntro:       `તમે કેટલી આવક ગુમાવો છો તે ગણવા દો. 3 ઝડપી પ્રશ્નો:`,
        bookCall:       `📞 ફ્રી કૉલ બૂક કરો`,
        seePricing:     `💰 કિંમત જુઓ`,
        tryDemo:        `👀 ડેમો જુઓ`,
        connecting:     `અમારી ટીમ સાથે જોડાઈ રહ્યા છીએ... 👨‍💻\n\nએક માનવ એજન્ટ ટૂંક સમયમાં આ ચેટ સંભાળશે. તમારી સુવિધા માટે AI બોટને મ્યૂટ કરવામાં આવ્યો છે.`,
        connectingAdmin: `મેં મારા સ્વચાલિત જવાબો થોભાવ્યા છે. એક TopEdge AI સિસ્ટમ આર્કિટેક્ટ આ ચેટની સમીક્ષા કરશે અને ખૂબ જ જલ્દી તમને સીધો જવાબ આપશે!\n\n*(જો તમે કોઈપણ સમયે બોટને ફરીથી શરૂ કરવા માંગતા હો, તો ફક્ત "Menu" ટાઈપ કરો)*`,
        validNumber:    `કૃપા કરીને માન્ય નંબર દાખલ કરો.`,
        pricingMsg:     `*TopEdge AI કિંમત* 💰\n\n- બિઝનેસ સ્ટાર્ટર: ₹4,999/ma\n- ગ્રોથ પ્રો: ₹12,999/ma\n- એન્ટરપ્રાઇઝ કસ્ટમ: ₹25,000 થી\n\nતમામ પ્લાન્સમાં 24/7 AI, પૂર્ણ CRM ઇન્ટિગ્રેશન અને 100% સ્વચાલિત ફોલો-અપ્સ શામેલ છે.\n\nતૈયાર છો? 👇`,
        discoveryCallBody: `અમારી ટેકનિકલ ટીમ સાથે તમારું ફ્રી 30-મિનિટનું વ્યૂહરચના સત્ર શેડ્યૂલ કરો. તમારા માટે શ્રેષ્ઠ સમય પસંદ કરો 👇`,
        discoveryCallBtn: `હમણાં બુક કરો`,
        faqPricing:     `💰 કિંમત`,
        faqIntegrations: `🔗 ઇન્ટિગ્રેશન`,
        faqOnboarding:  `⏱️ ઓનબોર્ડિંગ`,
        integrationMsg: `અમારા AI ચેટબોટ્સ અને વોઈસ કોલર્સ આની સાથે જોડાય છે:\n\n✅ Shopify\n✅ Zoho CRM\n✅ Google Calendar\n✅ Custom APIs\n\nઅમે ડેટા એન્ટ્રી અને ફોલો-અપ્સને સ્વચાલિત કરવા માટે તમારી હાલની સિસ્ટમ્સ સાથે સીધા જ જોડાઈએ છીએ.`,
        onboardingMsg: `🚀 *TopEdge AI સાથે શરૂઆત*\n\n1. સ્ટ્રેટેજી કૉલ (આજે)\n2. ડેમો અને મંજૂરી (દિવસ 1-2)\n3. ટેકનિકલ સેટઅપ (દિવસ 3-4)\n4. લાઈવ લોન્ચ (દિવસ 5)\n\nઅમે તમારા માટે બધું જ બનાવીએ અને મેનેજ કરીએ છીએ.`,
        contactDelitech: `અમારા લાઇવ ક્લાયંટ Delitech ને જુઓ — તેઓ અત્યારે આ ચાલવી રહ્યા છે:`,
        confirmBooking: (day, time) => `✅ થઈ ગયું!\nતમારો કૉલ ${day} ના રોજ ${time} વાગ્યે બુક થયો છે.`,
    },
    hi: {
        greeting:       (name) => `नमस्ते ${name}! मैं TopEdge AI डेमो बॉट हूँ 🤖`,
        qualifier:      `जादू दिखाने से पहले, एक छोटा सा सवाल —`,
        isOwner:        `🏢 मेरा अपना व्यवसाय है`,
        isExplorer:     `🔍 बस देख रहा हूँ`,
        isDev:          `💼 मैं एक डेवलपर / एजेंसी हूँ`,
        whichVertical:  `आपका व्यवसाय किस श्रेणी में आता है?`,
        salon:          `💇‍♀️ सैलून / स्पा`,
        turf:           `🏟️ टर्फ / स्पोर्ट्स`,
        clinic:         `🩺 क्लीनिक / स्वास्थ्य सेवा`,
        ecommerce:      `🛒 ई-कॉमर्स / रिटेल`,
        roiIntro:       `मुझे यह गणना करने दें कि आप कितनी आय खो रहे हैं। 3 त्वरित प्रश्न:`,
        bookCall:       `📞 फ्री कॉल बुक करें`,
        seePricing:     `💰 कीमत देखें`,
        tryDemo:        `👀 डेमो देखें`,
        connecting:     `हमारी टीम से जुड़ रहे हैं... 👨‍💻\n\nएक मानव एजेंट जल्द ही इस चैट को संभाल लेगा। आपकी सुविधा के लिए AI बॉट को म्यूट कर दिया गया है।`,
        connectingAdmin: `मैंने अपनी स्वचालित प्रतिक्रियाएँ रोक दी हैं। एक TopEdge AI सिस्टम आर्किटेक्ट इस चैट की समीक्षा करेगा और बहुत जल्द आपको सीधे जवाब देगा!\n\n*(यदि आप कभी भी बॉट को पुनरारंभ करना चाहते हैं, तो बस "Menu" टाइप करें)*`,
        validNumber:    `कृपया एक वैध संख्या दर्ज करें।`,
        pricingMsg:     `*TopEdge AI मूल्य निर्धारण* 💰\n\n- बिजनेस स्टार्टर: ₹4,999/ma\n- ग्रोथ प्रो: ₹12,999/ma\n- एंटरप्राइज कस्टम: ₹25,000 से\n\nसभी प्लान में 24/7 AI, पूर्ण CRM एकीकरण और 100% स्वचालित फॉलो-अप शामिल हैं।\n\nतैयार हैं? 👇`,
        discoveryCallBody: `हमारी तकनीकी टीम के साथ अपना मुफ्त 30 मिनट का रणनीति सत्र निर्धारित करें। वह समय चुनें जो आपके लिए सबसे अच्छा हो 👇`,
        discoveryCallBtn: `अभी बुक करें`,
        faqPricing:     `💰 मूल्य निर्धारण`,
        faqIntegrations: `🔗 एकीकरण`,
        faqOnboarding:  `⏱️ ऑनबोर्डिंग`,
        integrationMsg: `हमारे AI चैटबॉट्स और वॉयस कॉलर्स इनके साथ एकीकृत होते हैं:\n\n✅ Shopify\n✅ Zoho CRM\n✅ Google Calendar\n✅ Custom APIs\n\nहम डेटा प्रविष्टि और फॉलो-अप को स्वचालित करने के लिए आपके मौजूदा सिस्टम से सीधे जुड़ते हैं।`,
        onboardingMsg: `🚀 *TopEdge AI के साथ शुरुआत*\n\n1. रणनीति कॉल (आज)\n2. डेमो और अनुमोदन (दिन 1-2)\n3. तकनीकी सेटअप (दिन 3-4)\n4. लाइव लॉन्च (दिन 5)\n\nहम आपके लिए सब कुछ बनाते और प्रबंधित करते हैं।`,
        contactDelitech: `हमारे लाइव क्लायंट Delitech को देखें — वे अभी इसे चला रहे हैं:`,
        confirmBooking: (day, time) => `✅ हो गया!\nआपकी कॉल ${day} को ${time} बजे बुक की गई है।`,
    }
};
ाल —`,
        isOwner:        `🏢 मेरा अपना व्यवसाय है`,
        isExplorer:     `🔍 बस देख रहा हूँ`,
        isDev:          `💼 मैं एक डेवलपर / एजेंसी हूँ`,
        whichVertical:  `आपका व्यवसाय किस श्रेणी में आता है?`,
        salon:          `💇‍♀️ सैलून / स्पा`,
        turf:           `🏟️ टर्फ / स्पोर्ट्स`,
        clinic:         `🩺 क्लीनिक / स्वास्थ्य सेवा`,
        ecommerce:      `🛒 ई-कॉमर्स / रिटेल`,
        roiIntro:       `मुझे यह गणना करने दें कि आप कितनी आय खो रहे हैं। 3 त्वरित प्रश्न:`,
        bookCall:       `📞 फ्री कॉल बुक करें`,
        seePricing:     `💰 कीमत देखें`,
        tryDemo:        `👀 डेमो देखें`,
    }
};

// --- CORE HELPERS ---

async function trackEvent(phone, event, clientConfig, metadata = {}) {
    try {
        await BotAnalytics.create({
            clientId: clientConfig.clientId,
            phoneNumber: phone,
            event: event,
            metadata: metadata,
            createdAt: new Date()
        });
        console.log(`[EVENT SAVED: ${event}] Phone: ${phone}`);
    } catch (err) { console.error('Track Event Error:', err.message); }
}

// --- WEEKLY ADMIN REPORT ---
// Runs every Sunday at 9:00 AM
cron.schedule('0 9 * * 0', async () => {
    try {
        console.log("⏰ Running Weekly TopEdge Analytics Report...");
        const clients = await require('../../models/Client').find({ businessType: 'agency' });
        
        for (const client of clients) {
            const adminPhone = client.adminPhoneNumber || client.config?.adminPhoneNumber || process.env.ADMIN_PHONE;
            if (!adminPhone) continue;

            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const events = await BotAnalytics.find({
                clientId: client.clientId,
                createdAt: { $gte: sevenDaysAgo }
            });

            const stats = {
                leads: events.filter(e => e.event === EVENTS.SESSION_START).length,
                demos: EventsFilter(events, EVENTS.DEMO_OPENED),
                calls: EventsFilter(events, EVENTS.CALL_BOOKED),
                roiDone: EventsFilter(events, EVENTS.ROI_COMPLETED)
            };

            const reportMsg = `📊 *TopEdge AI Weekly Report*\n\nHere’s how your AI performed this week:\n\n👤 New Leads Interacted: ${stats.leads}\n👀 Demos Viewed: ${stats.demos}\n🧮 ROI Calculations: ${stats.roiDone}\n📞 Strategy Calls Booked: ${stats.calls}\n\nKeep growing! 🚀`;

            await axios({
                method: 'POST',
                url: `https://graph.facebook.com/v21.0/${client.phoneNumberId}/messages`,
                headers: { 'Authorization': `Bearer ${client.whatsappToken}`, 'Content-Type': 'application/json' },
                data: { messaging_product: 'whatsapp', to: adminPhone, type: 'text', text: { body: reportMsg } }
            }).catch(e => console.error("Error sending report:", e.message));
        }
    } catch (err) { console.error('Weekly Report Error:', err.message); }
});

function EventsFilter(events, eventName) {
    return events.filter(e => e.event === eventName).length;
}


async function incrementLeadScore(lead, points) {
    if (!lead.meta) lead.meta = {};
    lead.meta.leadScore = (lead.meta.leadScore || 0) + points;
    await lead.save();
}

function getLeadTemperature(score) {
    if (score >= 60) return { label: '🔥 HOT',  urgent: true  };
    if (score >= 30) return { label: '♻️ WARM', urgent: false };
    if (score >= 10) return { label: '🧩 COOL', urgent: false };
    return                  { label: '🧊 COLD', urgent: false };
}

function clearAllTimers(phone) {
    const timers = timerMap.get(phone) || [];
    timers.forEach(t => clearTimeout(t));
    timerMap.delete(phone);
}

function scheduleTimers(phone, phoneNumberId, io, clientConfig) {
    // In production we use real values. Testing values mentioned in Module 3 rules:
    // 30s/2min/5min for testing.
    const t1 = setTimeout(() => sendTier1(phone, phoneNumberId, io, clientConfig), 15 * 60 * 1000); 
    const t2 = setTimeout(() => sendTier2(phone, phoneNumberId, io, clientConfig), 3 * 3600 * 1000);
    const t3 = setTimeout(() => sendTier3(phone, phoneNumberId, io, clientConfig), 24 * 3600 * 1000);
    timerMap.set(phone, [t1, t2, t3]);
}

// --- TIER 1 — 15 MINUTE NUDGE ---
async function sendTier1(phone, phoneNumberId, io, clientConfig) {
    try {
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });
        if (!lead || lead.humanIntervention || lead.meta.doNotDisturb) return;

        let msg = '';
        const state = lead.meta.roiStep ? `roi_step${lead.meta.roiStep}` : lead.meta.sessionState;

        if (state === 'roi_step1') 
            msg = 'Still there? You were about to discover your exact revenue gap — takes 2 more answers 😊';
        else if (state === 'roi_step2') 
            msg = 'Almost there! One more number and I\'ll show you your monthly loss 📊';
        else if (state === 'roi_step3') 
            msg = 'Last step! Enter your average value and I\'ll calculate your number 💰';
        else if (state === 'viewing_demo') 
            msg = `Did you get to try the ${lead.meta.businessVertical} demo? Tap any option to continue 👇`;
        else if (state === 'faq') 
            msg = 'Any questions I can answer? Happy to help 🙋';
        else 
            msg = "Hey! Still here if you have questions 😊 Tap 'Menu' to pick up where you left off.";

        await sendWhatsAppText({ phoneNumberId, to: phone, body: msg, io, clientConfig });
        await trackEvent(phone, EVENTS.FOLLOWUP_SENT, clientConfig, { tier: 1 });
    } catch (err) { console.error('Tier 1 Error:', err.message); }
}

// --- TIER 2 — 3 HOUR WARM FOLLOW-UP ---
async function sendTier2(phone, phoneNumberId, io, clientConfig) {
    try {
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });
        if (!lead || lead.humanIntervention || lead.meta.doNotDisturb) return;

        let text = '';
        if (lead.meta.roiCalculated) {
            text = `Hey ${lead.name}! You calculated ₹${lead.meta.roiResult.monthlyGain.toLocaleString()}/month in potential gains earlier.\nOur team has a 20-min slot open tomorrow to show you exactly how we'd build this.\nWant to grab it?`;
        } else if (lead.meta.demosViewed && lead.meta.demosViewed.length > 0) {
            text = `Hey ${lead.name}! You checked out our ${lead.meta.demosViewed[0]} demo earlier.\nDid it look like something your business could use? Happy to answer any questions 😊`;
        } else {
            text = `Hey ${lead.name}! Anything I can help clarify about TopEdge AI?\nWe automate WhatsApp for businesses like yours in 3–5 days 🚀`;
        }

        await sendWhatsAppInteractive({
            phoneNumberId, to: phone, body: text,
            interactive: {
                type: 'button',
                action: {
                    buttons: [
                        { type: 'reply', reply: { id: 'book_call',    title: '📞 Book free call' } },
                        { type: 'reply', reply: { id: 'faq_pricing', title: '💰 Show me pricing' } },
                        { type: 'reply', reply: { id: 'not_now',      title: '⏰ Maybe later' } }
                    ]
                }
            },
            io, clientConfig
        });
        await trackEvent(phone, EVENTS.FOLLOWUP_SENT, clientConfig, { tier: 2 });
    } catch (err) { console.error('Tier 2 Error:', err.message); }
}

// --- TIER 3 — 24 HOUR NEXT-DAY MESSAGE ---
async function sendTier3(phone, phoneNumberId, io, clientConfig) {
    try {
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });
        if (!lead || lead.humanIntervention || lead.meta.doNotDisturb) return;

        const roiLine = lead.meta.roiCalculated
            ? `You had ₹${lead.meta.roiResult.monthlyGain.toLocaleString()}/month on the table yesterday — still interested?`
            : `We help businesses automate WhatsApp in 3–5 days. No tech skills needed.`;

        const text = `Good morning ${lead.name}! 🌞\nJust checking in from TopEdge AI.\n${roiLine}\nTap below if you'd like to explore this week:`;

        await sendWhatsAppInteractive({
            phoneNumberId, to: phone, body: text,
            interactive: {
                type: 'button',
                action: {
                    buttons: [
                        { type: 'reply', reply: { id: 'menu_main', title: '✅ Yes, let\'s talk' } },
                        { type: 'reply', reply: { id: 'opt_roi',      title: '🧮 Calculate my ROI' } },
                        { type: 'reply', reply: { id: 'stop_msgs',   title: '🚫 Stop messages' } }
                    ]
                }
            },
            io, clientConfig
        });
        await trackEvent(phone, EVENTS.FOLLOWUP_SENT, clientConfig, { tier: 3 });
    } catch (err) { console.error('Tier 3 Error:', err.message); }
}


// --- DEMO ROUTING (Module 4 implementation) ---

const PROOF_MESSAGES = {
    salon: [
        "By the way — Choice Salon saw 40% fewer no-shows in month 1. Their front desk now handles 3x more clients 💇‍♀️",
        "A salon in Surat added ₹82,000/month in recovered appointments within 6 weeks of going live 📈"
    ],
    turf: [
        "Fun fact: our turf client filled 6 extra hours/week after launch. That's ₹40k/month in pure extra revenue ⚽",
        "A cricket ground in Vadodara now fills empty slots via WhatsApp broadcast. Zero manual calls needed 🏏"
    ],
    clinic: [
        "One of our clinic clients dropped no-shows from 30% → 8% in 6 weeks with AI reminders 🏥",
        "Dental clinic: 40+ extra appointments/month recovered. Patients actually thank them for the reminders 😊"
    ],
    ecommerce: [
        "Delitech handles 200+ WhatsApp orders/day, fully automated. Response time: under 3 seconds, 24/7 🛒",
        "Fashion retailer increased repeat purchases by 34% with AI-powered order updates and reorder reminders 📦"
    ]
};

async function routeToIndustryDemo(phone, vertical, userName, phoneNumberId, io, clientConfig) {
    const intros = {
        salon:     `${userName}, here's exactly what your salon clients would experience on WhatsApp:\n👇 Try booking an appointment as if you were a customer —`,
        turf:      `${userName}, here's how your turf bookings would look on WhatsApp:\n👇 Go ahead, book a slot like your customers would —`,
        clinic:    `${userName}, here's the patient experience your clinic would deliver:\n👇 Try selecting a department and booking as a patient —`,
        ecommerce: `${userName}, here's what your store's WhatsApp could look like:\n👇 Check out our live client Delitech — they're running this right now:`
    };

    const s = STRINGS[clientConfig.language || 'en'];
    await sendWhatsAppText({ phoneNumberId, to: phone, body: intros[vertical], io, clientConfig });
    
    const flowIds = {
        salon:     '1977238969670742',
        turf:      '2142814969819669',
        clinic:    '1163688705769254',
        ecommerce: null
    };

    setTimeout(async () => {
        if (flowIds[vertical]) {
            await sendWhatsAppFlow({ phoneNumberId, to: phone, flowId: flowIds[vertical], body: "Click below to start your demo!", io, clientConfig });
        } else {
            // Ecommerce vcards
            const vcardDeli = {
                vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:Delitech SmartHomes\nTEL;TYPE=CELL:+919429784875\nEND:VCARD"
            };
            await sendWAContact({ phoneNumberId, to: phone, vcard: vcardDeli.vcard, io, clientConfig });
        }
    }, 1500);

    // Update lead meta
    const lead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });
    if (lead) {
        if (!lead.meta.demosViewed) lead.meta.demosViewed = [];
        if (!lead.meta.demosViewed.includes(vertical)) lead.meta.demosViewed.push(vertical);
        lead.meta.sessionState = 'viewing_demo';
        await incrementLeadScore(lead, 5);
        await lead.save();
    }

    // After 30 seconds, send social proof
    setTimeout(() => sendSocialProof(phone, vertical, phoneNumberId, io, clientConfig), 30000);

    await trackEvent(phone, EVENTS.DEMO_OPENED, clientConfig, { vertical });
}

async function sendSocialProof(phone, vertical, phoneNumberId, io, clientConfig) {
    try {
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });
        if (!lead || lead.humanIntervention || lead.meta.doNotDisturb) return;

        const key = `proofShown_${vertical}`;
        const idx = lead.meta[key] || 0;
        const proofs = PROOF_MESSAGES[vertical];
        const msg = proofs[idx % proofs.length];

        await sendWhatsAppText({ phoneNumberId, to: phone, body: msg, io, clientConfig });
        
        setTimeout(async () => {
            const s = STRINGS[lead.meta.language || 'en'];
            await sendWhatsAppInteractive({
                phoneNumberId, to: phone, body: 'Want to see how this would work for YOUR business specifically?',
                interactive: {
                    type: 'button',
                    action: {
                        buttons: [
                            { id: 'book_call', title: '📞 Book a free call' },
                            { id: 'opt_roi',    title: '🧮 Calculate my ROI' },
                            { id: 'faq_pricing',   title: '💰 See pricing' }
                        ]
                    }
                },
                io, clientConfig
            });
        }, 1500);

        lead.meta[key] = idx + 1;
        await incrementLeadScore(lead, 3);
        await lead.save();
    } catch (err) { console.error('Social Proof Error:', err.message); }
}

function timeAgo(date) {
    if (!date) return 'Never';
    const seconds = Math.floor((new Date() - date) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + " years ago";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + " months ago";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + " days ago";
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + " hours ago";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + " mins ago";
    return Math.floor(seconds) + " secs ago";
}

async function sendAdminAlert(phone, user, reason, clientConfig) {
    try {
        const score = user.meta?.leadScore || 0;
        const temp = getLeadTemperature(score);
        const adminPhone = clientConfig.config?.adminPhoneNumber || clientConfig.config?.adminPhones?.[0] || process.env.ADMIN_PHONE;
        
        const msg =
            `${temp.label} TopEdge Lead Alert\n` +
            `──────────────────\n` +
            `Name:      ${user.name}\n` +
            `Phone:     wa.me/${phone}\n` +
            `Industry:  ${user.meta?.businessVertical || 'Unknown'}\n` +
            `Score:     ${score}/100\n` +
            `Reason:    ${reason}\n` +
            `Demos:     ${user.meta?.demosViewed?.join(', ') || 'None'}\n` +
            `ROI done:  ${user.meta?.roiCalculated ? 'Yes → ₹' + user.meta?.roiResult?.monthlyGain?.toLocaleString() + '/mo' : 'No'}\n` +
            `Last seen: ${timeAgo(user.meta?.lastActivity)}\n` +
            `──────────────────\n` +
            `Tap to chat: wa.me/${phone}`;

        // Using process.env.ADMIN_PHONE as fallback if client config lacks it
        const target = adminPhone;
        if (target) {
            await axios({
                method: 'POST',
                url: `https://graph.facebook.com/v21.0/${clientConfig.phoneNumberId}/messages`,
                headers: { 'Authorization': `Bearer ${clientConfig.whatsappToken}`, 'Content-Type': 'application/json' },
                data: { messaging_product: 'whatsapp', to: target, type: 'text', text: { body: msg } }
            });
        }
    } catch (err) { console.error('Admin Alert Error:', err.message); }
}

async function handleCallBooked(phone, payload, clientConfig, io) {
    try {
        const { day, time, cust_name, business } = payload;
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });

        // Confirm to user
        const confirmMsg = 
            `✅ Done, ${cust_name}!\n` +
            `Your free strategy call is booked for ${day} at ${time} IST.\n` +
            `We'll call you on this WhatsApp number.\n` +
            `A reminder will be sent 30 minutes before 👋`;
        
        await sendWhatsAppText({ phoneNumberId: clientConfig.phoneNumberId, to: phone, body: confirmMsg, io, clientConfig });

        // Update DB
        if (lead) {
            lead.meta.callBooked = { day, time, cust_name, business, bookedAt: new Date() };
            lead.meta.sessionState = 'call_booked';
            lead.humanIntervention = true; // Mute bot after booking
            await incrementLeadScore(lead, 25);
            await lead.save();

            // Alert admin
            await sendAdminAlert(phone, lead, 'Call booked 📞', clientConfig);
            
            // Extra detail to admin
            const adminPhone = clientConfig.config?.adminPhoneNumber || clientConfig.config?.adminPhones?.[0] || process.env.ADMIN_PHONE;
            if (adminPhone) {
                const detailMsg = `📋 *Call details for ${cust_name}:*\nBusiness: ${business}\nSlot: ${day} at ${time}`;
                await axios({
                    method: 'POST',
                    url: `https://graph.facebook.com/v21.0/${clientConfig.phoneNumberId}/messages`,
                    headers: { 'Authorization': `Bearer ${clientConfig.whatsappToken}`, 'Content-Type': 'application/json' },
                    data: { messaging_product: 'whatsapp', to: adminPhone, type: 'text', text: { body: detailMsg } }
                });
            }
        }

        await trackEvent(phone, EVENTS.CALL_BOOKED, clientConfig, { day, time });
    } catch (err) { console.error('Handle Call Booked Error:', err.message); }
}





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

        // --- TIMER & ACTIVITY MANAGEMENT ---
        clearAllTimers(userPhone);
        scheduleTimers(userPhone, phoneId, io, clientConfig);

        // Ensure lead exists
        let lead = await AdLead.findOne({ phoneNumber: userPhone, clientId: clientConfig.clientId });
        if (!lead) {
            lead = await AdLead.create({
                clientId: clientConfig.clientId,
                phoneNumber: userPhone,
                name: userName,
                source: 'WhatsApp Organic',
                chatSummary: 'Started TopEdge AI session',
                meta: { 
                    roiStep: 0, 
                    leadScore: 0, 
                    demosViewed: [], 
                    lastActivity: new Date() 
                }
            });
            await trackEvent(userPhone, EVENTS.SESSION_START, clientConfig);
        } else {
            lead.meta.lastActivity = new Date();
            await lead.save();
        }
        
        // Block if human intervention is active (except for "Menu" to reset)
        const incomingRaw = msg.type === 'text' ? msg.text.body : (msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.id || '');
        const textLower = incomingRaw.toLowerCase();

        if (lead.humanIntervention && !['hi', 'hello', 'hey', 'start', 'menu', 'menu_main'].includes(textLower)) {
            return res.sendStatus(200);
        }

        let incomingText = incomingRaw;

        await saveAndEmitMessage({ to: userPhone, body: msg.type === 'text' ? incomingText : `[Interaction: ${incomingText}]`, type: msg.type, io, clientConfig, from: userPhone });

        // -- LANGUAGE SELECTOR (Module 7 integration) --
        if (!lead.meta.language && !incomingText.startsWith('lang_')) {
            const langMsg = "Welcome to TopEdge AI! 🤖\nSelect your language / ભાષા પસંદ કરો";
            await sendWhatsAppInteractive({
                phoneNumberId: phoneId, to: userPhone, body: langMsg,
                interactive: {
                    type: 'button',
                    action: {
                        buttons: [
                            { type: 'reply', reply: { id: 'lang_en', title: 'English' } },
                            { type: 'reply', reply: { id: 'lang_gu', title: 'ગુજરાતી' } },
                            { type: 'reply', reply: { id: 'lang_hi', title: 'हिन्दी' } }
                        ]
                    }
                },
                io, clientConfig
            });
            return res.sendStatus(200);
        }

        if (incomingText.startsWith('lang_')) {
            const lang = incomingText.split('_')[1];
            lead.meta.language = lang;
            lead.meta.sessionState = 'lang_selection';
            await lead.save();
            await trackEvent(userPhone, EVENTS.LANG_SELECTED, clientConfig, { lang });
            
            // Proceed to Greeting + Qualifier
            const s = STRINGS[lang];
            await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: s.greeting(userName), io, clientConfig });
            
            setTimeout(async () => {
                await sendWhatsAppInteractive({
                    phoneNumberId: phoneId, to: userPhone, body: s.qualifier,
                    interactive: {
                        type: 'button',
                        action: {
                            buttons: [
                                { type: 'reply', reply: { id: 'qual_owner', title: s.isOwner } },
                                { type: 'reply', reply: { id: 'qual_explorer', title: s.isExplorer } },
                                { type: 'reply', reply: { id: 'qual_dev', title: s.isDev } }
                            ]
                        }
                    },
                    io, clientConfig
                });
            }, 1500);
            return res.sendStatus(200);
        }

        const s = STRINGS[lead.meta.language || 'en'];

        // -- 0. FLOW RESPONSE HANDLER --
        if (msg.type === 'interactive' && msg.interactive.type === 'nfm_reply') {
            const flowResponse = JSON.parse(msg.interactive.nfm_reply.response_json);
            
            // Check if it's the Call Booking flow
            if (flowResponse.day && flowResponse.time) {
                await handleCallBooked(userPhone, flowResponse, clientConfig, io);
                return res.sendStatus(200);
            }
            
            // Fallback to original flow logic (if any, for other flows)
            // For now, we'll just acknowledge and return if it's not the call flow
            // If there were other flows, their specific handling would go here.
            console.log("Received NFM Reply for unhandled flow:", flowResponse);
            return res.sendStatus(200);
        }

        // -- QUALIFIER HANDLERS --
        if (incomingText.startsWith('qual_')) {
            const type = incomingText.replace('qual_', '');
            lead.meta.leadType = type;
            lead.meta.qualifiedAt = new Date();
            lead.meta.sessionState = 'qualifier_done';
            
            if (type === 'owner') {
                await incrementLeadScore(lead, 10);
                await lead.save();
                setTimeout(async () => {
                    await sendWhatsAppInteractive({
                        phoneNumberId: phoneId, to: userPhone, body: s.whichVertical,
                        interactive: {
                            type: 'button',
                            action: {
                                buttons: [
                                    { type: 'reply', reply: { id: 'vert_salon', title: s.salon } },
                                    { type: 'reply', reply: { id: 'vert_turf', title: s.turf } },
                                    { type: 'reply', reply: { id: 'vert_clinic', title: s.clinic } }
                                ]
                            }
                        },
                        io, clientConfig
                    });
                }, 1000);
            } else if (type === 'dev') {
                await incrementLeadScore(lead, 5);
                const devMsg = "Great! Here's what's relevant for you:\n→ API documentation: topedgeai.com/docs\n→ We build on official WhatsApp Cloud API\n→ White-label partnerships available\n→ Custom flow development: from ₹15,000";
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: devMsg, io, clientConfig });
                setTimeout(async () => {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: s.greeting(userName), interactive: mainMenuInteractive, io, clientConfig });
                }, 2000);
                lead.meta.sessionState = 'main_menu';
            } else {
                await incrementLeadScore(lead, 2);
                await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: s.greeting(userName), interactive: mainMenuInteractive, io, clientConfig });
                lead.meta.sessionState = 'main_menu';
            }
            
            await lead.save();
            await trackEvent(userPhone, EVENTS.QUALIFIER_DONE, clientConfig, { type });
            return res.sendStatus(200);
        }

        // -- VERTICAL HANDLER --
        if (incomingText.startsWith('vert_')) {
            const vertical = incomingText.replace('vert_', '');
            lead.meta.businessVertical = vertical;
            lead.meta.sessionState = 'vertical_selected';
            await incrementLeadScore(lead, 5);
            await lead.save();
            await trackEvent(userPhone, EVENTS.VERTICAL_PICKED, clientConfig, { vertical });
            
            // Route to industry demo (Module 4)
            await routeToIndustryDemo(userPhone, vertical, userName, phoneId, io, clientConfig);
            return res.sendStatus(200);
        }

        // -- ROI CALCULATOR STATE MACHINE (Updated logic to be industry-specific in Module 2) --
        if (lead.meta && lead.meta.roiStep > 0 && msg.type === 'text') {
            const num = parseInt(incomingText.replace(/[^0-9]/g, ''), 10);
            if (isNaN(num)) {
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: s.validNumber, io, clientConfig });
                return res.sendStatus(200);
            }

            const vertical = lead.meta.businessVertical || 'salon'; // Default to salon if somehow unset

            if (lead.meta.roiStep === 1) {
                if (vertical === 'salon') lead.meta.monthlyClients = num;
                else if (vertical === 'turf') lead.meta.totalHours = num;
                else if (vertical === 'clinic') lead.meta.dailyAppointments = num;
                else if (vertical === 'ecommerce') lead.meta.dailyInquiries = num;
                
                lead.meta.roiStep = 2;
                await lead.save();

                let nextQ = "";
                if (vertical === 'salon') nextQ = "What % of appointments are no-shows or last-minute cancels? (e.g. 15 for 15%)";
                else if (vertical === 'turf') nextQ = "How many of those hours go unbooked on average per day?";
                else if (vertical === 'clinic') nextQ = "What % of appointments are no-shows? (e.g. 10 for 10%)";
                else if (vertical === 'ecommerce') nextQ = "How many do you actually reply to within 1 hour on average?";
                
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: nextQ, io, clientConfig });
                return res.sendStatus(200);
            }
            if (lead.meta.roiStep === 2) {
                if (vertical === 'salon') lead.meta.noShowRate = num;
                else if (vertical === 'turf') lead.meta.emptyHours = num;
                else if (vertical === 'clinic') lead.meta.noShowRate = num;
                else if (vertical === 'ecommerce') lead.meta.repliedTo = num;

                lead.meta.roiStep = 3;
                await lead.save();

                let nextQ = "";
                if (vertical === 'salon') nextQ = "What is your average service value per client in ₹?";
                else if (vertical === 'turf') nextQ = "What is your per-hour booking rate in ₹?";
                else if (vertical === 'clinic') nextQ = "What is your average consultation fee in ₹?";
                else if (vertical === 'ecommerce') nextQ = "What is your average order value in ₹?";

                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: nextQ, io, clientConfig });
                return res.sendStatus(200);
            }
            if (lead.meta.roiStep === 3) {
                let monthlyGain = 0;
                let currentLoss = 0;
                let roiMsg = "";

                if (vertical === 'salon') {
                    const monthlyClients = lead.meta.monthlyClients || 100;
                    const noShowRate = lead.meta.noShowRate || 10;
                    const avgValue = num;
                    const missedClients = (monthlyClients * noShowRate) / 100;
                    currentLoss = missedClients * avgValue;
                    monthlyGain = Math.round(missedClients * 0.70 * avgValue); // AI recovers 70%
                    const yearlyGain = monthlyGain * 12;

                    roiMsg = `📊 *Here's your revenue gap:*\n━━━━━━━━━━━━━━━━━\nMonthly no-shows: \`${Math.round(missedClients)}\` clients\nMonthly loss: \`₹${currentLoss.toLocaleString()}\`\n*AI recovery (70%): ₹${monthlyGain.toLocaleString()}/month*\n*Yearly gain: ₹${yearlyGain.toLocaleString()}/year*\n━━━━━━━━━━━━━━━━━\nYou're leaving *₹${monthlyGain.toLocaleString()}* on the table every single month. 💰`;
                } else if (vertical === 'turf') {
                    const totalHours = lead.meta.totalHours || 12;
                    const emptyHours = lead.meta.emptyHours || 4;
                    const hourlyRate = num;
                    const dailyLoss = emptyHours * hourlyRate;
                    currentLoss = dailyLoss * 26; // Monthly loss
                    monthlyGain = Math.round(emptyHours * 0.65 * hourlyRate * 26); // AI fills 65%
                    
                    roiMsg = `📊 *Your turf revenue gap:*\n━━━━━━━━━━━━━━━━━\nEmpty hours/day: \`${emptyHours}\` hours\nDaily loss: \`₹${dailyLoss.toLocaleString()}\`\nMonthly loss: \`₹${currentLoss.toLocaleString()}\`\n*AI slot-fill gain: ₹${monthlyGain.toLocaleString()}/month*\n━━━━━━━━━━━━━━━━━\n\`${emptyHours}\` empty hours daily = *₹${currentLoss.toLocaleString()}* evaporating every month. 🔥`;
                } else if (vertical === 'clinic') {
                    const dailyAppointments = lead.meta.dailyAppointments || 20;
                    const noShowRate = lead.meta.noShowRate || 15;
                    const consultFee = num;
                    const dailyNoShows = (dailyAppointments * noShowRate) / 100;
                    currentLoss = Math.round(dailyNoShows * consultFee * 26);
                    monthlyGain = Math.round(dailyNoShows * 0.75 * consultFee * 26); // AI recovers 75%

                    roiMsg = `📊 *Your clinic revenue gap:*\n━━━━━━━━━━━━━━━━━\nDaily no-shows: \`${dailyNoShows.toFixed(1)}\` patients\nMonthly loss: \`₹${currentLoss.toLocaleString()}\`\n*AI recovery (75%): ₹${monthlyGain.toLocaleString()}/month*\n━━━━━━━━━━━━━━━━━\n\`${dailyNoShows.toFixed(1)}\` patients ghost you daily. AI reminders + auto-rebooking fix that. 🏥`;
                } else if (vertical === 'ecommerce') {
                    const dailyInquiries = lead.meta.dailyInquiries || 50;
                    const repliedTo = lead.meta.repliedTo || 20;
                    const avgOrder = num;
                    const missedLeads = dailyInquiries - repliedTo;
                    currentLoss = Math.round(missedLeads * avgOrder * 0.35 * 30); // 35% conversion
                    monthlyGain = Math.round(missedLeads * 0.90 * avgOrder * 0.35 * 30); // AI replies to 90%

                    roiMsg = `📊 *Your store's revenue gap:*\n━━━━━━━━━━━━━━━━━\nMissed inquiries/day: \`${missedLeads}\`\nMonthly lost sales: \`₹${currentLoss.toLocaleString()}\`\n*AI recovery (90%): ₹${monthlyGain.toLocaleString()}/month*\n━━━━━━━━━━━━━━━━━\nYou're missing \`${missedLeads}\` potential buyers every single day. 🛒`;
                }
                
                lead.meta.roiStep = 0; 
                lead.meta.roiCalculated = true;
                lead.meta.roiResult = { monthlyGain, currentLoss, vertical };
                await incrementLeadScore(lead, 15);
                await lead.save();
                await trackEvent(userPhone, EVENTS.ROI_COMPLETED, clientConfig, { vertical, gain: monthlyGain });

                // Check for HOT threshold
                if (lead.meta.leadScore >= 60 && !lead.meta.hotAlertSent) {
                    await sendAdminAlert(userPhone, lead, 'Score hit HOT threshold 🔥', clientConfig);
                    lead.meta.hotAlertSent = true;
                    await lead.save();
                }

                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: roiMsg, io, clientConfig });
                
                setTimeout(async () => {
                    await sendWhatsAppInteractive({
                        phoneNumberId: phoneId, to: userPhone,
                        body: "Want to see exactly how we'd set this up for your business?",
                        interactive: {
                            type: 'button',
                            action: {
                                buttons: [
                                    { type: 'reply', reply: { id: 'book_call', title: s.bookCall } },
                                    { type: 'reply', reply: { id: 'demo_industry', title: s.tryDemo } },
                                    { type: 'reply', reply: { id: 'faq_pricing', title: s.seePricing } }
                                ]
                            }
                        },
                        io, clientConfig
                    });
                }, 2000);
                
                return res.sendStatus(200);
            }
        }

        // -- 2. MAIN MENU ROUTING --
        if (['hi', 'hello', 'hey', 'start', 'menu', 'menu_main'].includes(textLower)) {
            // Reset state
            lead.meta.roiStep = 0;
            lead.humanIntervention = false;
            await lead.save();

            const greet = s.greeting(userName) + "\n\nWe provide advanced 24/7 WhatsApp AI Chatbots and Voice Callers helping businesses like Salons, Clinics, and E-Commerce scale and recover lost leads instantly.\n\nWhat would you like to explore today? 👇";
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
            
            case 'demo_industry':
                const ind = lead.meta.businessVertical || 'salon';
                await routeToIndustryDemo(userPhone, ind, userName, phoneId, io, clientConfig);
                break;
            
            case 'opt_roi':
                if (!lead.meta.businessVertical) {
                    await sendWhatsAppInteractive({
                        phoneNumberId: phoneId, to: userPhone, body: s.whichVertical,
                        interactive: {
                            type: 'button',
                            action: {
                                buttons: [
                                    { type: 'reply', reply: { id: 'vert_salon', title: s.salon } },
                                    { type: 'reply', reply: { id: 'vert_turf', title: s.turf } },
                                    { type: 'reply', reply: { id: 'vert_clinic', title: s.clinic } }
                                ]
                            }
                        },
                        io, clientConfig
                    });
                    return;
                }
                const vertical = lead.meta.businessVertical;
                lead.meta.roiStep = 1;
                await lead.save();
                await trackEvent(userPhone, EVENTS.ROI_STARTED, clientConfig, { vertical });

                let firstQ = "";
                if (vertical === 'salon') firstQ = "1️⃣ How many clients visit your salon per month? (Just type a number)";
                else if (vertical === 'turf') firstQ = "1️⃣ How many hours is your turf available per day? (e.g. 15)";
                else if (vertical === 'clinic') firstQ = "1️⃣ How many patient appointments do you have per day?";
                else if (vertical === 'ecommerce') firstQ = "1️⃣ How many customer inquiries do you get per day on WhatsApp?";
                
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: `🧮 *Let's calculate exactly how much revenue you're missing.*\n\n${firstQ}`, io, clientConfig });
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

            case 'book_call':
                await incrementLeadScore(lead, 10);
                await lead.save();
                await sendWhatsAppFlow({
                    phoneNumberId: phoneId, to: userPhone,
                    flowId: CALL_FLOW_ID,
                    body: "Schedule your free 30-minute strategy session with our technical team. Pick a time that works best for you 👇",
                    buttonText: "Book Now",
                    io, clientConfig
                });
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
                const CLINIC_FLOW_ID = '1163688705769254';
                const CALL_FLOW_ID = 'YOUR_CALL_FLOW_ID'; // User to replace after creating the Flow in Meta Builder
                await sendWhatsAppFlow({ phoneNumberId: phoneId, to: userPhone, flowId: CLINIC_FLOW_ID, body: "🩺 *Clinic Booking Demo*\n\nTest how patients can complete an intake form and request a doctor consultation natively.", buttonText: 'Book Clinic', io, clientConfig });
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
