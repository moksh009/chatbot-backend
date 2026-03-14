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
const socialProofTimerMap = new Map(); // FIX 5: Separate tracked timers for social proof
const SALON_FLOW_ID = '1977238969670742';
const TURF_FLOW_ID = '2142814969819669';
const CLINIC_FLOW_ID = '1163688705769254';
// User to replace after creating the Flow in Meta Builder

// FIX 3: Input validation helper
function isValidROINumber(input) {
    const n = parseFloat(String(input).trim().replace(/,/g, ''));
    return !isNaN(n) && n >= 0 && n < 1000000;
}

// FIX 7: Vertical label map for safe interpolation
const VERTICAL_LABELS = {
    salon: 'Salon',
    turf: 'Turf',
    clinic: 'Clinic',
    ecommerce: 'E-Commerce'
};

const INDUSTRY_IMAGES = {
    salon: 'https://images.unsplash.com/photo-1595476108010-b4d1f10d5e43?w=800&q=80',
    turf: 'https://images.unsplash.com/photo-1551280857-2b9bbe5240bc?w=800&q=80',
    clinic: 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?w=800&q=80',
    ecommerce: 'https://images.unsplash.com/photo-1472851294608-062f824d29cc?w=800&q=80',
    ecom_pizza: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=800&q=80',
    ecom_burger: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800&q=80',
    ecom_pasta: 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=800&q=80'
};

const EVENTS = {
    SESSION_START: 'session_start',
    LANG_SELECTED: 'lang_selected',
    QUALIFIER_DONE: 'qualifier_done',
    VERTICAL_PICKED: 'vertical_picked',
    DEMO_OPENED: 'demo_opened',
    DEMO_COMPLETED: 'demo_completed',
    ROI_STARTED: 'roi_started',
    ROI_COMPLETED: 'roi_completed',
    FOLLOWUP_SENT: 'followup_sent',
    FOLLOWUP_REPLIED: 'followup_replied',
    CALL_BOOKED: 'call_booked',
    HUMAN_REQUESTED: 'human_requested',
    OPT_OUT: 'opt_out'
};

const STRINGS = {
    en: {
        greeting: (name) => `Hey ${name}! I'm the TopEdge AI demo bot 🤖`,
        qualifier: `Before I show you the magic, quick question —`,
        isOwner: `🏢 I own a business`,
        isExplorer: `🔍 Just exploring`,
        isDev: `💼 I'm a developer / agency`,
        whichVertical: `Perfect! Which best describes your business?`,
        salon: `💇‍♀️ Salon / Spa`,
        turf: `🏟️ Turf / Sports`,
        clinic: `🩺 Clinic / Healthcare`,
        ecommerce: `🛒 E-Commerce / Retail`,
        roiIntro: `Let me calculate exactly how much revenue you're missing. 3 quick questions:`,
        bookCall: `📞 Book a free call`,
        seePricing: `💰 See pricing`,
        tryDemo: `👀 Try a demo`,
        connecting: `Connecting you to our team... 👨‍💻\n\nA human agent will take over this chat shortly. The AI bot has been muted for your convenience.`,
        connectingAdmin: `I have paused my automated responses. A TopEdge AI system architect will review this chat and reply to you directly very soon!\n\n*(If you want to restart the bot anytime, just type "Menu")*`,
        validNumber: `Please enter a valid number.`,
        pricingMsg: `*TopEdge AI Pricing* 💰\n\n- Business Starter: ₹4,999/mo\n- Growth Pro: ₹12,999/mo\n- Enterprise Custom: From ₹25,000\n\nAll plans include 24/7 AI, full CRM integration, and 100% automated follow-ups.\n\nReady to get started? 👇`,
        discoveryCallBody: `Schedule your free 30-minute strategy session with our technical team. Pick a time that works best for you 👇`,
        discoveryCallBtn: `Book Now`,
        faqPricing: `💰 Pricing`,
        faqIntegrations: `🔗 Integrations`,
        faqOnboarding: `⏱️ Onboarding`,
        integrationMsg: `Our AI Chatbots and Voice Callers integrate with:\n\n✅ Shopify\n✅ Zoho CRM\n✅ Google Calendar\n✅ Custom APIs\n\nWe connect directly to your existing systems to automate data entry and follow-ups.`,
        onboardingMsg: `🚀 *Getting Started with TopEdge AI*\n\n1. Strategy Call (Today)\n2. Demo & Approval (Day 1-2)\n3. Technical Setup (Day 3-4)\n4. Live Launch (Day 5)\n\nWe build and manage everything for you.`,
        contactDelitech: `Check out our live client Delitech — they're running this right now:`,
        confirmBooking: (day, time) => `✅ Done!\nYour call is booked for ${day} at ${time} IST.`,
    },
    gu: {
        greeting: (name) => `કેમ છો ${name}! TopEdge AI 🤖`,
        qualifier: `જાદુ બતાવતા પહેલા, પ્રશ્ન —`,
        isOwner: `🏢 મારો ધંધો`,
        isExplorer: `🔍 ફક્ત જોઉ છું`,
        isDev: `💼 Developer/Agency`,
        whichVertical: `તમારો ધંધો કઈ શ્રેણીમાં?`,
        salon: `💇 સલૂન / સ્પા`,
        turf: `🏟 ટર્ફ / સ્પોર્ટ્સ`,
        clinic: `🩺 ક્લિનિક`,
        ecommerce: `🛒 ઈ-કૉમર્સ`,
        roiIntro: `3 ઝડપી પ્રશ્નો:`,
        bookCall: `📞 ફ્રી કૉલ`,
        seePricing: `💰 ભાવ જુઓ`,
        tryDemo: `👀 ડેમો`,
        connecting: `અમારી ટીમ સાથે જોડાઈ રહ્યા... 👨‍💻\n\nAI બોટ મ્યૂટ, agent ટૂંક સમયમાં.`,
        connectingAdmin: `સ્વચાલિત જવાબ થોભ્યા. TopEdge AI expert ટૂંક સમયમાં reply કરશે!\n\n*(ફરી: "Menu" ટાઈપ કરો)*`,
        validNumber: `માન્ય નંબર દાખલ કરો.`,
        pricingMsg: `*TopEdge AI ભાવ* 💰\n\n- Starter: ₹4,999/mo\n- Growth Pro: ₹12,999/mo\n- Enterprise: ₹25,000+\n\n24/7 AI + CRM + ફોલો-અપ.\n\nતૈયાર? 👇`,
        discoveryCallBody: `ફ્રી 30-min strategy call. સમય પસંદ કરો 👇`,
        discoveryCallBtn: `Book Now`,
        faqPricing: `💰 ભાવ`,
        faqIntegrations: `🔗 Integrations`,
        faqOnboarding: `⏱ Onboarding`,
        integrationMsg: `Shopify, Zoho CRM, Google Calendar, Custom APIs\n\nતમારી સિસ્ટમ સાથે connect.`,
        onboardingMsg: `🚀 *TopEdge AI શરૂ*\n1. Call (આજ)\n2. Demo (Day 1-2)\n3. Setup (Day 3-4)\n4. Live (Day 5)`,
        contactDelitech: `Delitech જુઓ — live running:`,
        confirmBooking: (day, time) => `✅ Done!\nCall: ${day} ${time} IST.`,
    },
    hi: {
        greeting: (name) => `नमस्ते ${name}! TopEdge AI 🤖`,
        qualifier: `जादू से पहले, एक सवाल —`,
        isOwner: `🏢 मेरा व्यवसाय है`,
        isExplorer: `🔍 बस देख रहा हूँ`,
        isDev: `💼 Developer/Agency`,
        whichVertical: `आपका व्यवसाय कौन सा?`,
        salon: `💇 सैलून / स्पा`,
        turf: `🏟 टर्फ / स्पोर्ट्स`,
        clinic: `🩺 क्लीनिक`,
        ecommerce: `🛒 ई-कॉमर्स`,
        roiIntro: `3 त्वरित सवाल:`,
        bookCall: `📞 फ्री कॉल`,
        seePricing: `💰 कीमत देखें`,
        tryDemo: `👀 डेमो`,
        connecting: `टीम से जुड़ रहे हैं... 👨‍💻\n\nAI मूट, agent जल्द आएगा.`,
        connectingAdmin: `स्वचालित जवाब रोके। TopEdge AI expert जल्द reply करेगा!\n\n*(फिर: "Menu" टाइप करें)*`,
        validNumber: `वैध संख्या दर्ज करें।`,
        pricingMsg: `*TopEdge AI मूल्य* 💰\n\n- Starter: ₹4,999/mo\n- Growth Pro: ₹12,999/mo\n- Enterprise: ₹25,000+\n\n24/7 AI + CRM + फॉलो-अप.\n\nतैयार? 👇`,
        discoveryCallBody: `फ्री 30-min strategy call. समय चुनें 👇`,
        discoveryCallBtn: `Book Now`,
        faqPricing: `💰 मूल्य`,
        faqIntegrations: `🔗 Integrations`,
        faqOnboarding: `⏱ Onboarding`,
        integrationMsg: `Shopify, Zoho CRM, Google Calendar, Custom APIs\n\nआपके system से connect.`,
        onboardingMsg: `🚀 *TopEdge AI शुरू*\n1. Call (आज)\n2. Demo (Day 1-2)\n3. Setup (Day 3-4)\n4. Live (Day 5)`,
        contactDelitech: `Delitech देखें — live running:`,
        confirmBooking: (day, time) => `✅ Done!\nCall: ${day} ${time} IST.`,
    }
};

// --- RE-ENGAGEMENT HELPERS ---
function ensureLeadMeta(lead) {
    if (!lead) return;
    if (!lead.meta) lead.meta = {};
}

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
    ensureLeadMeta(lead);
    lead.meta.leadScore = (lead.meta.leadScore || 0) + points;
    lead.markModified('meta');
    await lead.save();
}

function getLeadTemperature(score) {
    if (score >= 60) return { label: '🔥 HOT', urgent: true };
    if (score >= 30) return { label: '♻️ WARM', urgent: false };
    if (score >= 10) return { label: '🧩 COOL', urgent: false };
    return { label: '🧊 COLD', urgent: false };
}

function clearAllTimers(phone) {
    const timers = timerMap.get(phone) || [];
    timers.forEach(t => clearTimeout(t));
    timerMap.delete(phone);
}

function scheduleTimers(phone, phoneNumberId, io, clientConfig) {
    // SINGLE nudge only — 1 hour after last activity, fires ONCE per session
    const t1 = setTimeout(() => sendInactivityNudge(phone, phoneNumberId, io, clientConfig), 1 * 3600 * 1000);
    timerMap.set(phone, [t1]);
}

// --- SINGLE INACTIVITY NUDGE — 1 HOUR ---
async function sendInactivityNudge(phone, phoneNumberId, io, clientConfig) {
    try {
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });
        ensureLeadMeta(lead);
        if (!lead || lead.humanIntervention || lead.meta.doNotDisturb) return;

        // Only send ONCE — if we already nudged this session, stop
        if (lead.meta.nudgeSentThisSession) return;

        let msg = '';
        const state = lead.meta.roiStep ? `roi_step${lead.meta.roiStep}` : lead.meta.sessionState;
        const vertical = lead.meta.businessVertical || 'your';

        if (state === 'roi_step1')
            msg = 'Still there? You were about to discover your exact revenue gap — takes 2 more answers 😊';
        else if (state === 'roi_step2')
            msg = 'Almost there! One more number and I\'ll show you your monthly loss 📊';
        else if (state === 'roi_step3')
            msg = 'Last step! Enter your average value and I\'ll calculate your number 💰';
        else if (state === 'viewing_demo')
            msg = `Did you get to try the ${vertical} demo? Pick an option below to continue 👇`;
        else if (state === 'faq')
            msg = 'Any questions I can answer? Happy to help 🙋';
        else
            msg = 'Hey! Still here if you have questions 😊 Pick an option below to continue 👇';

        await sendWhatsAppInteractive({
            phoneNumberId, to: phone, body: msg,
            interactive: {
                type: 'button',
                action: {
                    buttons: [
                        { type: 'reply', reply: { id: 'menu_main', title: '📋 Main Menu' } },
                        { type: 'reply', reply: { id: 'opt_chatbot', title: '📱 Live Demo' } },
                        { type: 'reply', reply: { id: 'book_call', title: '📞 Book Call' } }
                    ]
                }
            },
            io, clientConfig
        });

        // Mark nudge as sent so we never send again this session
        lead.meta.nudgeSentThisSession = true;
        lead.markModified('meta');
        await lead.save();

        await trackEvent(phone, EVENTS.FOLLOWUP_SENT, clientConfig, { tier: 1 });
} catch (err) { console.error('Nudge Error:', err.message); }
}

// --- ROI HELPER FUNCTIONS ---
async function calculateAndShowROI(phone, lead, phoneNumberId, io, clientConfig) {
  const inquiries     = lead.meta.monthlyInquiries || 150;
  const closeRate     = lead.meta.closeRate || 0.20;
  const rtLoss        = lead.meta.responseTimeLoss || 0.25;
  const avgValue      = lead.meta.avgValue || 1500;
  const vertical      = lead.meta.businessVertical || 'salon';
  const service       = lead.meta.roiService || '';

  // CALCULATION:
  // Leads lost due to slow response
  const leadsLostToSpeed    = Math.round(inquiries * rtLoss);

  // Of those lost leads, AI recovers 80% (instant 24/7 response)
  const leadsRecovered      = Math.round(leadsLostToSpeed * 0.80);

  // Additional closures from recovered leads
  const extraClosures       = Math.round(leadsRecovered * closeRate);

  // Monthly revenue gain
  const monthlyGain         = extraClosures * avgValue;

  // Annual projection
  const yearlyGain          = monthlyGain * 12;

  // Current monthly loss (what they're bleeding right now)
  const currentMonthlyLoss  = leadsLostToSpeed * closeRate * avgValue;

  // Daily loss
  const dailyLoss           = Math.round(currentMonthlyLoss / 30);

  // Build result message
  const vertLabel = { salon: 'Salon', turf: 'Turf', clinic: 'Clinic', ecommerce: 'E-Commerce' };
  const resultMsg =
    `📊 *Your TopEdge AI ROI Report*\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `🏢 Business:      ${vertLabel[vertical]}\n` +
    `📦 Service:       ${service.replace('roi_svc_', '').replace(/_/g, ' ')}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `📉 *CURRENT SITUATION*\n` +
    `Inquiries lost/month: ${leadsLostToSpeed}\n` +
    `Revenue lost/month:   ₹${currentMonthlyLoss.toLocaleString('en-IN')}\n` +
    `Revenue lost/day:     ₹${dailyLoss.toLocaleString('en-IN')}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `📈 *WITH TOPEDGE AI*\n` +
    `Leads recovered/month: ${leadsRecovered}\n` +
    `Extra closures/month:  ${extraClosures}\n` +
    `Monthly gain:          ₹${monthlyGain.toLocaleString('en-IN')}\n` +
    `Annual projection:     ₹${yearlyGain.toLocaleString('en-IN')}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `*Ready to capture ₹${monthlyGain.toLocaleString('en-IN')}/month?* 👇`;

  // Save to DB
  lead.meta.roiStep = 0;
  lead.meta.roiCalculated = true;
  lead.meta.roiResult = {
    monthlyGain,
    currentMonthlyLoss,
    yearlyGain,
    leadsRecovered,
    extraClosures,
    dailyLoss
  };
  lead.markModified('meta');
  await incrementLeadScore(lead, 20);
  await lead.save();
  await trackEvent(phone, EVENTS.ROI_COMPLETED, clientConfig, {
    vertical,
    monthlyGain,
    service: lead.meta.roiService
  });

  // Send result
  await sendWhatsAppText({ phoneNumberId, to: phone, body: resultMsg, io, clientConfig });

  // After 2s send post-demo options
  setTimeout(async () => {
    await sendPostDemoOptions(phone, vertical, phoneNumberId, io, clientConfig);
  }, 2000);
}

async function sendServiceSelector(phone, vertical, phoneNumberId, io, clientConfig) {
  const serviceOptions = {
    salon: {
      body: "What type of salon services do you primarily offer?",
      rows: [
        { id: 'roi_svc_haircut',   title: '✂️ Haircuts & Styling',    description: 'Cuts, blowouts, styling' },
        { id: 'roi_svc_spa',       title: '💆 Spa & Treatments',       description: 'Facials, massage, care' },
        { id: 'roi_svc_color',     title: '🎨 Colouring & Chemical',   description: 'Balayage, keratin, etc.' },
        { id: 'roi_svc_bridal',    title: '👰 Bridal & Makeup',        description: 'Events & wedding packages' }
      ]
    },
    turf: {
      body: "What sport is your turf primarily used for?",
      rows: [
        { id: 'roi_svc_cricket',   title: '🏏 Cricket',    description: 'Box or full pitch' },
        { id: 'roi_svc_football',  title: '⚽ Football',   description: '5-a-side or full ground' },
        { id: 'roi_svc_badminton', title: '🏸 Badminton',  description: 'Indoor/outdoor courts' },
        { id: 'roi_svc_multi',     title: '🏟️ Multi-Sport',description: 'Mixed usage' }
      ]
    },
    clinic: {
      body: "What is your primary medical department?",
      rows: [
        { id: 'roi_svc_dental',    title: '🦷 Dental',         description: 'General & cosmetic dentistry' },
        { id: 'roi_svc_skin',      title: '✨ Dermatology',     description: 'Skin & hair treatments' },
        { id: 'roi_svc_general',   title: '🩺 General Physician',description: 'Consultations & check-ups' },
        { id: 'roi_svc_physio',    title: '💪 Physiotherapy',   description: 'Rehab & sports injuries' }
      ]
    },
    ecommerce: {
      body: "What best describes your store?",
      rows: [
        { id: 'roi_svc_fashion',    title: '👗 Fashion & Apparel',   description: 'Clothing & accessories' },
        { id: 'roi_svc_food',       title: '🍔 Food & Beverages',    description: 'Restaurant, cloud kitchen' },
        { id: 'roi_svc_electronics',title: '📱 Electronics',         description: 'Gadgets & accessories' },
        { id: 'roi_svc_homegoods',  title: '🏠 Home & Lifestyle',    description: 'Furniture & decor' }
      ]
    }
  };

  const opt = serviceOptions[vertical] || serviceOptions.salon;

  await sendWhatsAppInteractive({
    phoneNumberId, to: phone,
    body: opt.body,
    interactive: {
      type: 'list',
      action: {
        button: 'Select Service',
        sections: [{ title: 'Your Primary Service', rows: opt.rows }]
      }
    },
    io, clientConfig
  });
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
        salon: `${userName}, Welcome to TopEdge AI Salon 💇‍♀️\n\n👇 Try booking an appointment as if you were a customer — tap the button below:`,
        turf: `${userName}, Welcome to TopEdge AI Turf ⚽\n\n👇 Go ahead, book a slot like your customers would — tap the button below:`,
        clinic: `${userName}, Welcome to TopEdge AI Clinic 🩺\n\n👇 Try selecting a department and booking as a patient — tap the button below:`,
        ecommerce: `${userName}, Welcome to TopEdge AI E-Commerce 🛒\n\n👇 Explore our digital food catalog and experience smooth ordering:`
    };

    // Explicitly send industry-specific image attached to the Demo Intro (per user request)
    const demoImage = INDUSTRY_IMAGES[vertical] || LOGO_URL;
    await sendWhatsAppImage({ phoneNumberId, to: phone, imageUrl: demoImage, caption: intros[vertical], io, clientConfig });

    const flowIds = {
        salon:     SALON_FLOW_ID,
        turf:      TURF_FLOW_ID,
        clinic:    CLINIC_FLOW_ID,
        ecommerce: null
    };

    const flowButtons = {
        salon: 'Book Salon Flow',
        turf: 'Book Turf Flow',
        clinic: 'Book Clinic Flow',
    };

    const flowScreens = {
        salon: 'SALON_HOME',
        turf: 'TURF_HOME',
        clinic: 'CLINIC_HOME',
    };

    setTimeout(async () => {
        let flowSuccess = false;

        // 1. Send Ecommerce Food Demo
        if (vertical === 'ecommerce') {
            await sendWhatsAppInteractive({
                phoneNumberId, to: phone,
                body: "🍔 *Digital Menu & Fast Ordering*\n\nSelect a category to view our mouth-watering options:",
                interactive: {
                    type: 'list',
                    action: {
                        button: 'View Menu',
                        sections: [{
                            title: 'Categories',
                            rows: [
                                { id: 'ecom_pizza', title: '🍕 Wood-Fired Pizza', description: 'Freshly baked pizzas' },
                                { id: 'ecom_burger', title: '🍔 Smash Burgers', description: 'Juicy gourmet burgers' },
                                { id: 'ecom_pasta', title: '🍝 Fresh Pasta', description: 'Authentic Italian pasta' }
                            ]
                        }]
                    }
                }, io, clientConfig
            });
        }
        // 2. Send Native Flow Demo if available
        else if (flowIds[vertical]) {
            flowSuccess = await sendWhatsAppFlow({ phoneNumberId, to: phone, flowId: flowIds[vertical], body: `Secure your spot in seconds! Tap below to open our dynamic booking flow.`, buttonText: flowButtons[vertical] || 'Try Demo', screenName: flowScreens[vertical] || 'HOME', io, clientConfig });

            // Fallback if Meta API rejects the unpublished/draft Flow ID
            if (!flowSuccess) {
                await sendWhatsAppInteractive({
                    phoneNumberId, to: phone,
                    body: `*(Note: The native ${vertical} Flow is currently offline for maintenance by Meta. You can still test our conversational AI!)*`,
                    interactive: {
                        type: 'button',
                        action: { buttons: [{ type: 'reply', reply: { id: `demo_${vertical}`, title: 'Simulate Booking' } }] }
                    },
                    io, clientConfig
                });
            }
        }
    }, 1500);

    // Update lead meta
    const lead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });
    ensureLeadMeta(lead);
    if (lead) {
        if (!lead.meta.demosViewed) lead.meta.demosViewed = [];
        if (!lead.meta.demosViewed.includes(vertical)) lead.meta.demosViewed.push(vertical);
        lead.meta.sessionState = 'viewing_demo';
        lead.markModified('meta');
        await incrementLeadScore(lead, 5);
        await lead.save();
    }

    // FIX 5: After 30 seconds, send social proof (tracked & cancellable)
    if (flowIds[vertical]) {
        // Cancel any existing social proof timer for this user
        if (socialProofTimerMap.has(phone)) {
            clearTimeout(socialProofTimerMap.get(phone));
            socialProofTimerMap.delete(phone);
        }
        const spTimerId = setTimeout(async () => {
            socialProofTimerMap.delete(phone);
            const freshLead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });
            if (freshLead && freshLead.meta?.businessVertical === vertical && !freshLead.humanIntervention) {
                await sendSocialProof(phone, vertical, phoneNumberId, io, clientConfig);
            }
        }, 30000);
        socialProofTimerMap.set(phone, spTimerId);
    }

    await trackEvent(phone, EVENTS.DEMO_OPENED, clientConfig, { vertical });
}

async function sendPostDemoOptions(phone, vertical, phoneNumberId, io, clientConfig) {
    try {
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });
        if (!lead || lead.humanIntervention) return;
        ensureLeadMeta(lead);
        const s = STRINGS[lead.meta.language || 'en'];
        const hasRoi = lead.meta.roiCalculated;

        // FIX 7: Safe vertical label interpolation (no "undefined")
        const vertLabel = VERTICAL_LABELS[vertical] || 'your business';
        const roiDesc = vertical ? `See your revenue gap for ${vertLabel}` : 'See how much revenue you lose';

        await sendWhatsAppInteractive({
            phoneNumberId, to: phone,
            body: `What would you like to do next?`,
            interactive: {
                type: 'list',
                action: {
                    button: 'Choose an option',
                    sections: [{
                        title: 'Next Steps',
                        rows: [
                            { id: 'book_call', title: '📞 Book a free call', description: 'Talk to our team in 30 min' },
                            { id: 'opt_roi', title: '🧮 Calculate my ROI', description: roiDesc },
                            { id: 'switch_industry', title: '🔄 Try another industry', description: 'Explore a different demo' },
                            { id: 'faq_pricing', title: '💰 See pricing', description: 'Plans from ₹4,999/mo' },
                            { id: 'menu_main', title: '⬅️ Main Menu', description: 'Back to all options' }
                        ]
                    }]
                }
            },
            io, clientConfig
        });
    } catch (err) { console.error('Post Demo Options Error:', err.message); }
}

async function sendSocialProof(phone, vertical, phoneNumberId, io, clientConfig) {
    try {
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId: clientConfig.clientId });
        ensureLeadMeta(lead);
        if (!lead || lead.humanIntervention || lead.meta.doNotDisturb) return;

        // Critical Fix: If the user switched to a DIFFERENT industry before this 30s timer fired, abort!
        if (lead.meta.businessVertical && lead.meta.businessVertical !== vertical) return;

        const key = `proofShown_${vertical}`;
        const idx = lead.meta[key] || 0;
        const proofs = PROOF_MESSAGES[vertical];
        const msg = proofs[idx % proofs.length];

        await sendWhatsAppText({ phoneNumberId, to: phone, body: msg, io, clientConfig });

        setTimeout(async () => {
            await sendPostDemoOptions(phone, vertical, phoneNumberId, io, clientConfig);
        }, 1500);

        lead.meta[key] = idx + 1;
        lead.markModified('meta');
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
        ensureLeadMeta(lead);

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
            lead.markModified('meta');
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





// --- API WRAPPERS & AI ---

async function generateWithGemini(apiKey, prompt) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
        const resp = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
        const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return text.trim();
    } catch (err) {
        console.error('Gemini API Error (TopEdge ROI):', err.message);
        return null;
    }
}

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

const LOGO_URL = 'https://chatbot-backend-lg5y.onrender.com/public/images/logo.png';

async function sendWhatsAppImage({ phoneNumberId, to, imageUrl, caption = '', io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            to,
            type: 'image',
            image: { link: imageUrl, caption }
        }, { headers: { Authorization: `Bearer ${token}` } });
        await saveAndEmitMessage({ phoneNumberId, to, body: `[Image] ${caption}`, type: 'image', io, clientConfig });
        return true;
    } catch (err) { console.error('Image Error:', err.message); return false; }
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

async function sendWhatsAppFlow({ phoneNumberId, to, flowId, body, buttonText = 'Open Form', screenName, io, clientConfig }) {
    const token = clientConfig.whatsappToken;
    const apiVersion = process.env.API_VERSION || 'v18.0';
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

    // Build flow action — use navigate if screenName provided, otherwise data_exchange to auto-open
    const flowParams = {
        flow_message_version: '3',
        flow_token: `topedge_${flowId}`,
        flow_id: flowId,
        flow_cta: buttonText
    };

    if (screenName) {
        flowParams.flow_action = 'navigate';
        flowParams.flow_action_payload = { screen: screenName };
    } else {
        // Fallback to navigate with a default screen if data_exchange is failing
        flowParams.flow_action = 'navigate';
        flowParams.flow_action_payload = { screen: 'HOME' };
    }

    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'flow',
            header: { type: 'text', text: 'TopEdge AI Demo' },
            body: { text: body },
            footer: { text: 'Powered by TopEdge AI ⚡' },
            action: {
                name: 'flow',
                parameters: flowParams
            }
        }
    };
    try {
        const resp = await axios.post(url, data, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
        console.log('[FLOW SENT OK]', flowId, 'to', to);
        await saveAndEmitMessage({ phoneNumberId, to, body: `[Flow] ${body}`, type: 'interactive', io, clientConfig });
        return true;
    } catch (err) {
        console.error('Flow Error:', err.response?.data || err.message);
        console.error('Flow Error Details:', JSON.stringify(err.response?.data?.error || {}, null, 2));
        return false;
    }
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
                { id: 'opt_chatbot', title: '📱 Live Demo', description: 'See our automated WhatsApp flows' },
                { id: 'opt_live_demo', title: '⭐ Testimonials', description: 'Test our live AI clients' },
                { id: 'opt_caller', title: '📞 Test AI Caller', description: 'Experience live voice AI' },
                { id: 'opt_roi', title: '🧮 Calculate ROI', description: 'See how much revenue you lose' },
                { id: 'opt_faq', title: '❓ FAQs & Pricing', description: 'Got questions? Start here.' },
                { id: 'opt_human', title: '👨‍💻 Talk to Human', description: 'Connect with our team' }
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
        console.log(`[TOPEDGE_WEBHOOK] Raw Body:`, JSON.stringify(body, null, 2));

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
            ensureLeadMeta(lead);
            lead.meta.lastActivity = new Date();
            lead.meta.nudgeSentThisSession = false; // Reset so nudge can fire again after new activity
            lead.markModified('meta');
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

        // -- ROI INTERACTIVE MENU HANDLERS --
        // ROI Service selection
        if (incomingText.startsWith('roi_svc_')) {
          lead.meta.roiService = incomingText;
          lead.meta.roiStep = 2;
          lead.markModified('meta');
          await lead.save();
          // Send STEP 3 — inquiries list
          await sendWhatsAppInteractive({
            phoneNumberId: phoneId, to: userPhone,
            body: "📊 How many inquiries or bookings do you receive per month?",
            interactive: {
              type: 'list',
              action: {
                button: 'Select Range',
                sections: [{
                  title: 'Monthly Volume',
                  rows: [
                    { id: 'roi_inq_50',   title: '0 – 50',     description: 'Just getting started' },
                    { id: 'roi_inq_100',  title: '50 – 100',   description: 'Growing steadily' },
                    { id: 'roi_inq_200',  title: '100 – 200',  description: 'Active business' },
                    { id: 'roi_inq_500',  title: '200 – 500',  description: 'High volume' },
                    { id: 'roi_inq_1000', title: '500 – 1,000',description: 'Very high volume' },
                    { id: 'roi_inq_1001', title: '1,000+',      description: 'Enterprise level' }
                  ]
                }]
              }
            },
            io, clientConfig
          });
          return res.sendStatus(200);
        }

        // ROI Inquiries selection
        if (incomingText.startsWith('roi_inq_')) {
          const INQ_VALUES = {
            roi_inq_50: 25, roi_inq_100: 75, roi_inq_200: 150,
            roi_inq_500: 350, roi_inq_1000: 750, roi_inq_1001: 1200
          };
          lead.meta.monthlyInquiries = INQ_VALUES[incomingText];
          lead.meta.roiStep = 3;
          lead.markModified('meta');
          await lead.save();
          // Send STEP 4 — close rate buttons
          await sendWhatsAppInteractive({
            phoneNumberId: phoneId, to: userPhone,
            body: "💼 What % of those inquiries do you convert into paying customers?",
            interactive: {
              type: 'button',
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'roi_cr_10',  title: 'Under 10%' } },
                  { type: 'reply', reply: { id: 'roi_cr_25',  title: '10% – 30%' } },
                  { type: 'reply', reply: { id: 'roi_cr_50',  title: '30% – 50%' } }
                ]
              }
            },
            io, clientConfig
          });
          return res.sendStatus(200);
        }

        // ROI Close rate selection
        if (incomingText.startsWith('roi_cr_')) {
          const CR_VALUES = { roi_cr_10: 0.07, roi_cr_25: 0.20, roi_cr_50: 0.40 };
          lead.meta.closeRate = CR_VALUES[incomingText];
          lead.meta.roiStep = 4;
          lead.markModified('meta');
          await lead.save();
          // Send STEP 5 — response time buttons
          await sendWhatsAppInteractive({
            phoneNumberId: phoneId, to: userPhone,
            body: "⏱️ How fast do you typically respond to a new inquiry?",
            interactive: {
              type: 'button',
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'roi_rt_fast',   title: 'Under 5 mins' } },
                  { type: 'reply', reply: { id: 'roi_rt_medium', title: '30 mins – 1 hr' } },
                  { type: 'reply', reply: { id: 'roi_rt_slow',   title: '1 hour+' } }
                ]
              }
            },
            io, clientConfig
          });
          return res.sendStatus(200);
        }

        // ROI Response time selection
        if (incomingText.startsWith('roi_rt_')) {
          const RT_MULTIPLIER = { roi_rt_fast: 0.10, roi_rt_medium: 0.25, roi_rt_slow: 0.45 };
          lead.meta.responseTimeLoss = RT_MULTIPLIER[incomingText];
          lead.meta.roiStep = 5;
          lead.markModified('meta');
          await lead.save();
          // Send STEP 6 — average value list
          await sendWhatsAppInteractive({
            phoneNumberId: phoneId, to: userPhone,
            body: "💰 What is the average value of a single booking or order?",
            interactive: {
              type: 'list',
              action: {
                button: 'Select Range',
                sections: [{
                  title: 'Average Order / Service Value',
                  rows: [
                    { id: 'roi_val_200',   title: 'Under ₹500',       description: 'Quick / basic services' },
                    { id: 'roi_val_750',   title: '₹500 – ₹1,000',    description: 'Standard service' },
                    { id: 'roi_val_1500',  title: '₹1,000 – ₹2,000',  description: 'Premium service' },
                    { id: 'roi_val_3500',  title: '₹2,000 – ₹5,000',  description: 'Packages / events' },
                    { id: 'roi_val_7500',  title: '₹5,000 – ₹10,000', description: 'Treatments / large orders' },
                    { id: 'roi_val_15000', title: '₹10,000+',           description: 'Premium / enterprise' }
                  ]
                }]
              }
            },
            io, clientConfig
          });
          return res.sendStatus(200);
        }

        // ROI Average value selection — FINAL STEP, triggers calculation
        if (incomingText.startsWith('roi_val_')) {
          const VAL_VALUES = {
            roi_val_200: 350, roi_val_750: 750, roi_val_1500: 1500,
            roi_val_3500: 3500, roi_val_7500: 7500, roi_val_15000: 15000
          };
          lead.meta.avgValue = VAL_VALUES[incomingText];
          lead.meta.roiStep = 6;
          lead.markModified('meta');
          await lead.save();
          // CALCULATE AND SHOW RESULT
          await calculateAndShowROI(userPhone, lead, phoneId, io, clientConfig);
          return res.sendStatus(200);
        }

        // -- LANGUAGE SELECTOR (Module 7 integration) --
        ensureLeadMeta(lead);
        if (!lead.meta?.language && !incomingText.startsWith('lang_')) {
            const langMsg = "Welcome to *TopEdge AI* 🤖\nYour Business on Autopilot 🚀\n\nSelect your language / ભાષા પસંદ કરો";
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
            ensureLeadMeta(lead);
            lead.meta.language = lang;
            lead.meta.sessionState = 'lang_selection';
            lead.markModified('meta');
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

        // -- 0. FLOW RESPONSE HANDLER (nfm_reply) -- FIX 1: Per-industry parsers
        if (msg.type === 'interactive' && msg.interactive.type === 'nfm_reply') {
            let flowResponse = {};
            try {
                flowResponse = JSON.parse(msg.interactive.nfm_reply.response_json);
            } catch (e) {
                console.error('Failed to parse flow response JSON:', e.message);
                return res.sendStatus(200);
            }

            console.log('[FLOW RESPONSE]', JSON.stringify(flowResponse));

            // 1. Call Booking flow completion (has day + time)
            if (flowResponse.day && flowResponse.time && !flowResponse.service && !flowResponse.sport && !flowResponse.department) {
                await handleCallBooked(userPhone, flowResponse, clientConfig, io);
                return res.sendStatus(200);
            }

            // 2. Detect which flow completed by checking industry-specific fields
            const isSalon  = flowResponse.service !== undefined && flowResponse.sport === undefined;
            const isTurf   = flowResponse.sport !== undefined;
            const isClinic = flowResponse.department !== undefined;
            const vertical = isSalon ? 'salon' : isTurf ? 'turf' : isClinic ? 'clinic' : (lead.meta?.businessVertical || 'salon');

            let confirmMsg = '';

            if (isSalon) {
                confirmMsg =
                    `💇‍♀️ *Demo Booking Confirmed!*\n` +
                    `━━━━━━━━━━━━━━━━━\n` +
                    `📌 Service: ${flowResponse.service || 'N/A'}\n` +
                    `💇 Stylist: ${flowResponse.stylist || 'Any Available'}\n` +
                    `📅 Date: ${flowResponse.date || 'N/A'}\n` +
                    `⏰ Time: ${flowResponse.time || flowResponse.slot || flowResponse.time_slot || 'N/A'}\n` +
                    `👤 Name: ${flowResponse.customer_name || flowResponse.name || userName}\n` +
                    `━━━━━━━━━━━━━━━━━\n` +
                    `*This is exactly what your customers would see!* ☝️\n` +
                    `Fully automated 24/7 — zero manual work needed.`;
            } else if (isTurf) {
                confirmMsg =
                    `⚽ *Turf Booking Confirmed!*\n` +
                    `━━━━━━━━━━━━━━━━━\n` +
                    `🏅 Sport: ${flowResponse.sport || 'N/A'}\n` +
                    `⏱️ Duration: ${flowResponse.duration || 'N/A'}\n` +
                    `📅 Date: ${flowResponse.date || 'N/A'}\n` +
                    `⏰ Kick-off: ${flowResponse.time || flowResponse.slot || flowResponse.time_slot || 'N/A'}\n` +
                    `👤 Name: ${flowResponse.customer_name || flowResponse.name || userName}\n` +
                    `━━━━━━━━━━━━━━━━━\n` +
                    `*This is exactly what your customers would see!* ☝️\n` +
                    `Fully automated 24/7 — zero manual work needed.`;
            } else if (isClinic) {
                confirmMsg =
                    `🩺 *Appointment Confirmed!*\n` +
                    `━━━━━━━━━━━━━━━━━\n` +
                    `🏥 Department: ${flowResponse.department || 'N/A'}\n` +
                    `💊 Service: ${flowResponse.service || 'N/A'}\n` +
                    `📅 Date: ${flowResponse.date || 'N/A'}\n` +
                    `⏰ Time: ${flowResponse.time || flowResponse.slot || flowResponse.time_slot || 'N/A'}\n` +
                    `👤 Patient: ${flowResponse.patient_name || flowResponse.customer_name || flowResponse.name || userName}\n` +
                    `━━━━━━━━━━━━━━━━━\n` +
                    `*This is exactly what your patients would see!* ☝️\n` +
                    `Fully automated 24/7 — zero manual work needed.`;
            } else {
                // Generic fallback
                const details = [];
                if (flowResponse.service) details.push(`📌 Service: ${flowResponse.service}`);
                if (flowResponse.date)    details.push(`📅 Date: ${flowResponse.date}`);
                if (flowResponse.time || flowResponse.slot) details.push(`⏰ Time: ${flowResponse.time || flowResponse.slot}`);
                if (flowResponse.name || flowResponse.customer_name || flowResponse.patient_name) details.push(`👤 Name: ${flowResponse.patient_name || flowResponse.customer_name || flowResponse.name}`);
                const detailBlock = details.length > 0 ? details.join('\n') : '(Booking details captured)';
                confirmMsg =
                    `✅ *Demo Booking Confirmed!*\n━━━━━━━━━━━━━━━━━\n${detailBlock}\n━━━━━━━━━━━━━━━━━\n` +
                    `*This is exactly what your customers would see!* ☝️\nFully automated 24/7.`;
            }

            await sendWhatsAppInteractive({
                phoneNumberId: phoneId, to: userPhone,
                body: confirmMsg,
                interactive: {
                    type: 'button',
                    action: {
                        buttons: [
                            { type: 'reply', reply: { id: 'switch_industry', title: '🔄 Change Industry' } },
                            { type: 'reply', reply: { id: 'opt_roi', title: '🧮 Calculate ROI' } }
                        ]
                    }
                },
                io, clientConfig
            });

            // Update lead meta
            ensureLeadMeta(lead);
            lead.meta.businessVertical = vertical; // Ensure vertical is saved from flow detection
            lead.meta.sessionState = 'demo_completed';
            lead.markModified('meta');
            await incrementLeadScore(lead, 5);
            await lead.save();
            await trackEvent(userPhone, EVENTS.DEMO_COMPLETED, clientConfig, { vertical });

            // FIX 5: Schedule tracked social proof
            if (socialProofTimerMap.has(userPhone)) {
                clearTimeout(socialProofTimerMap.get(userPhone));
            }
            const spTimer = setTimeout(async () => {
                socialProofTimerMap.delete(userPhone);
                await sendSocialProof(userPhone, vertical, phoneId, io, clientConfig);
            }, 30000);
            socialProofTimerMap.set(userPhone, spTimer);

            return res.sendStatus(200);
        }

        // -- QUALIFIER HANDLERS --
        if (incomingText.startsWith('qual_')) {
            const type = incomingText.replace('qual_', '');
            ensureLeadMeta(lead);
            lead.meta.leadType = type;
            lead.meta.qualifiedAt = new Date();
            lead.meta.sessionState = 'qualifier_done';

            if (type === 'owner') {
                lead.markModified('meta');
                await incrementLeadScore(lead, 10);
                await lead.save();
                // Use a list to show all 4 verticals
                setTimeout(async () => {
                    await sendWhatsAppInteractive({
                        phoneNumberId: phoneId, to: userPhone, body: s.whichVertical,
                        interactive: {
                            type: 'list',
                            action: {
                                button: 'Select Industry',
                                sections: [{
                                    title: 'Your Business Type',
                                    rows: [
                                        { id: 'vert_salon', title: s.salon, description: 'Appointment & booking automation' },
                                        { id: 'vert_turf', title: s.turf, description: 'Slot booking & availability' },
                                        { id: 'vert_clinic', title: s.clinic, description: 'Patient intake & reminders' },
                                        { id: 'vert_ecommerce', title: s.ecommerce, description: 'Order & inquiry automation' }
                                    ]
                                }]
                            }
                        },
                        io, clientConfig
                    });
                }, 1000);
            } else if (type === 'dev') {
                lead.markModified('meta');
                await incrementLeadScore(lead, 5);
                const devMsg = "Great! Here's what's relevant for you:\n→ API documentation: topedgeai.com/docs\n→ We build on official WhatsApp Cloud API\n→ White-label partnerships available\n→ Custom flow development: from ₹15,000";
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: devMsg, io, clientConfig });
                setTimeout(async () => {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: s.greeting(userName), interactive: mainMenuInteractive, io, clientConfig });
                }, 2000);
                lead.meta.sessionState = 'main_menu';
                lead.markModified('meta');
            } else {
                lead.markModified('meta');
                await incrementLeadScore(lead, 2);
                await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: s.greeting(userName), interactive: mainMenuInteractive, io, clientConfig });
                lead.meta.sessionState = 'main_menu';
                lead.markModified('meta');
            }

            await lead.save();
            await trackEvent(userPhone, EVENTS.QUALIFIER_DONE, clientConfig, { type });
            return res.sendStatus(200);
        }

        // -- VERTICAL HANDLER -- FIX 8: Check context to route demo vs ROI
        if (incomingText.startsWith('vert_')) {
            const vertical = incomingText.replace('vert_', '');
            ensureLeadMeta(lead);
            const selectContext = lead.meta.industrySelectContext || 'demo';
            lead.meta.businessVertical = vertical;
            lead.meta.industrySelectContext = null; // Clear context after use
            lead.meta.sessionState = 'vertical_selected';
            lead.markModified('meta');
            await incrementLeadScore(lead, 5);
            await lead.save();
            await trackEvent(userPhone, EVENTS.VERTICAL_PICKED, clientConfig, { vertical });

            // FIX 8: Route based on WHY the selector was opened
            if (selectContext === 'roi') {
                // Go straight to ROI questions, skip demo
                lead.meta.roiStep = 1;
                lead.markModified('meta');
                await lead.save();
                await trackEvent(userPhone, EVENTS.ROI_STARTED, clientConfig, { vertical });

                // Send STEP 2 — service type selector based on vertical
                await sendServiceSelector(userPhone, vertical, phoneId, io, clientConfig);
            } else {
                // Default: Route to industry demo (Module 4)
                await routeToIndustryDemo(userPhone, vertical, userName, phoneId, io, clientConfig);
            }
            return res.sendStatus(200);
        }

        // -- ROI CALCULATOR STATE MACHINE (Refined Module 14) --
        ensureLeadMeta(lead);

        // -- E-COMMERCE CHECKOUT STATE MACHINE --
        if (msg.type === 'text') {
            if (lead.meta.sessionState === 'ecom_checkout_name') {
                lead.meta.customerName = incomingText;
                lead.meta.sessionState = 'ecom_checkout_address';
                lead.markModified('meta');
                await lead.save();
                await sendWhatsAppText({
                    phoneNumberId: phoneId, to: userPhone,
                    body: `Thanks ${incomingText}! 📍 Please type your full delivery address:`,
                    io, clientConfig
                });
                return res.sendStatus(200);
            }
            if (lead.meta.sessionState === 'ecom_checkout_address') {
                lead.meta.customerAddress = incomingText;
                lead.meta.sessionState = 'demo_completed';
                lead.markModified('meta');
                await incrementLeadScore(lead, 5);
                await lead.save();

                const itemDetails = lead.meta.ecomItem || 'your order';
                const confirmMsg = `✅ *Order Confirmed!*\n━━━━━━━━━━━━━━━━━\n🛒 Items: ${itemDetails}\n👤 Name: ${lead.meta.customerName}\n📍 Address: ${incomingText}\n🚚 Status: Out for delivery soon!\n━━━━━━━━━━━━━━━━━\n*This is exactly what your customers would experience!* ☝️\nFully automated 24/7 — zero manual work needed.`;
                
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: confirmMsg, io, clientConfig });
                
                // Track demo completion
                await trackEvent(userPhone, EVENTS.DEMO_COMPLETED, clientConfig, { vertical: 'ecommerce' });
                
                setTimeout(async () => {
                   await sendPostDemoOptions(userPhone, 'ecommerce', phoneId, io, clientConfig);
                }, 2000);
                
                return res.sendStatus(200);
            }
        }

        // -- 2. MAIN MENU ROUTING --
        if (['hi', 'hello', 'hey', 'start', 'menu', 'menu_main'].includes(textLower)) {
            // Reset state
            ensureLeadMeta(lead);
            lead.meta.roiStep = 0;
            lead.humanIntervention = false;
            lead.markModified('meta');
            await lead.save();

            // Combine Logo and Greeting into a single message using the caption
            const greet = `Hey ${userName}! I'm the TopEdge AI demo bot 🤖\n\nWe provide advanced 24/7 WhatsApp AI Chatbots and Voice Callers helping businesses like Salons, Clinics, and E-Commerce scale and recover lost leads instantly.\n\nWhat would you like to explore today? 👇`;
            await sendWhatsAppImage({ phoneNumberId: phoneId, to: userPhone, imageUrl: LOGO_URL, caption: greet, io, clientConfig });
            
            // Followed by the interactive menu
            setTimeout(async () => {
                await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "Menu Options", interactive: mainMenuInteractive, io, clientConfig });
            }, 1000);
            return res.sendStatus(200);
        }

        // --- Handle Ecommerce Food Catalog Actions ---
        if (incomingText.startsWith('ecom_')) {
            if (incomingText === 'ecom_proceed_checkout') {
                ensureLeadMeta(lead);
                lead.meta.sessionState = 'ecom_checkout_name';
                lead.markModified('meta');
                await lead.save();
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "Great! 📝 Please type your full name for the order:", io, clientConfig });
                return res.sendStatus(200);
            }

            const FOODS = {
                ecom_pizza: { name: "Margherita Pizza", price: "₹299", desc: "Classic cheese & fresh basil", emoji: "🍕", img: INDUSTRY_IMAGES.ecom_pizza },
                ecom_burger: { name: "Classic Smash Burger", price: "₹199", desc: "Double patty & cheddar cheese", emoji: "🍔", img: INDUSTRY_IMAGES.ecom_burger },
                ecom_pasta: { name: "Penne Alfredo", price: "₹249", desc: "Creamy white sauce with herbs", emoji: "🍝", img: INDUSTRY_IMAGES.ecom_pasta }
            };
            const item = FOODS[incomingText];
            if (item) {
                ensureLeadMeta(lead);
                lead.meta.ecomItem = item.name;
                lead.markModified('meta');
                await lead.save();

                // Send the image with caption 
                await sendWhatsAppImage({
                    phoneNumberId: phoneId, to: userPhone, imageUrl: item.img,
                    caption: `${item.emoji} *${item.name}*\n💰 ${item.price}\n📝 ${item.desc}\n\n*Simulated Checkout!* If this were your store, the user could instantly 'Add to Cart' and pay right here. Want to see the rest of the flow? 👇`,
                    io, clientConfig
                });
                
                // Send confirmation button to checkout or change industry
                setTimeout(async () => {
                    await sendWhatsAppInteractive({
                        phoneNumberId: phoneId, to: userPhone,
                        body: "Would you like to complete this test order?",
                        interactive: { 
                            type: 'button', 
                            action: { 
                                buttons: [
                                    { type: 'reply', reply: { id: 'ecom_proceed_checkout', title: 'Proceed to Checkout' } },
                                    { type: 'reply', reply: { id: 'switch_industry', title: 'Change Industry' } }
                                ] 
                            } 
                        },
                        io, clientConfig
                    });
                }, 1000);
            }
            return res.sendStatus(200);
        }

        switch (incomingText) {
            case 'opt_live_demo':
                await sendWhatsAppText({
                    phoneNumberId: phoneId, to: userPhone,
                    body: "⭐ *Live Client AI Chatbots*\n\nHere are some of our live, production clients. Feel free to click the links below and start a chat to test their conversational AI!\n\n💇‍♀️ *Choice Salon & Academy:*\n👉 https://wa.me/919274794547\n\n🛒 *Delitech SmartHomes:*\n👉 https://wa.me/919875251998",
                    io, clientConfig
                });
                break;
            case 'opt_chatbot':
                await sendWhatsAppInteractive({
                    phoneNumberId: phoneId, to: userPhone,
                    body: "We build tailored AI experiences for every industry.\n\nYou can test a live booking flow right now, or see how we handle eCommerce! 👇",
                    interactive: {
                        type: 'list',
                        action: {
                            button: 'Select Industry',
                            sections: [{
                                title: 'Live Demos',
                                rows: [
                                    { id: 'vert_salon', title: s.salon, description: 'Test Appointment Booking' },
                                    { id: 'vert_turf', title: s.turf, description: 'Test Slot Booking' },
                                    { id: 'vert_clinic', title: s.clinic, description: 'Test Patient Intake' },
                                    { id: 'vert_ecommerce', title: s.ecommerce, description: 'See Live E-Com Bots' }
                                ]
                            }]
                        }
                    },
                    io, clientConfig
                });
                break;

            case 'opt_caller':
                const callerMsg = "> 🎙️ *TopEdge AI Caller*\n\nWant to hear an AI negotiate, book appointments, and answer complex questions over a real phone call?\n\nTest our Live Voice AI directly on our website. Click the link below, call the number, and try to stump it!\n\n👉 *Visit:* https://www.topedgeai.com";
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: callerMsg, io, clientConfig });
                setTimeout(async () => {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "What would you like to do next?", interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'menu_main', title: 'Main Menu' } }] } }, io, clientConfig });
                }, 2000);
                break;

            case 'demo_industry':
                const ind = lead.meta.businessVertical || 'salon';
                await routeToIndustryDemo(userPhone, ind, userName, phoneId, io, clientConfig);
                break;

            case 'opt_roi':
                ensureLeadMeta(lead);
                if (!lead.meta.businessVertical) {
                    lead.meta.industrySelectContext = 'roi';
                    lead.markModified('meta');
                    await lead.save();

                    await sendWhatsAppInteractive({
                        phoneNumberId: phoneId, to: userPhone, body: s.whichVertical,
                        interactive: {
                            type: 'list',
                            action: {
                                button: 'Select Industry',
                                sections: [{
                                    title: 'Your Business Type',
                                    rows: [
                                        { id: 'vert_salon', title: s.salon, description: 'Appointment & booking automation' },
                                        { id: 'vert_turf', title: s.turf, description: 'Slot booking & availability' },
                                        { id: 'vert_clinic', title: s.clinic, description: 'Patient intake & reminders' },
                                        { id: 'vert_ecommerce', title: s.ecommerce, description: 'Order & inquiry automation' }
                                    ]
                                }]
                            }
                        },
                        io, clientConfig
                    });
                    return;
                }
                const vertical = lead.meta.businessVertical;
                lead.meta.roiStep = 1;
                lead.markModified('meta');
                await lead.save();
                await trackEvent(userPhone, EVENTS.ROI_STARTED, clientConfig, { vertical });
                
                // Send STEP 2 — service type selector based on vertical
                await sendServiceSelector(userPhone, vertical, phoneId, io, clientConfig);
                break;

            case 'opt_faq':
                await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "📚 *Frequently Asked Questions*\n\nSelect a topic below to learn more about how TopEdge AI seamlessly integrates into your business.", interactive: faqInteractive, io, clientConfig });
                break;

            case 'faq_pricing':
                await sendWhatsAppText({ phoneNumberId: phoneId, to: userPhone, body: "💰 *Pricing & Packages*\n\nWe offer custom-tailored solutions based on your lead volume and integration needs. \n\nOur base AI Chatbot packages start at just *₹4,999/month*, ensuring a massive ROI by recovering lost leads.\n\nWould you like a custom quote?", io, clientConfig });
                setTimeout(async () => {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "What's next?", interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'opt_human', title: 'Get Custom Quote' } }, { type: 'reply', reply: { id: 'menu_main', title: 'Main Menu' } }] } }, io, clientConfig });
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
                // FIX 6: Award points on intent + check HOT threshold
                ensureLeadMeta(lead);
                await incrementLeadScore(lead, 10);
                lead.meta.callIntentAt = new Date();
                lead.meta.sessionState = 'call_intent';
                lead.markModified('meta');
                await lead.save();

                // Check if score crossed HOT threshold
                if (lead.meta.leadScore >= 60 && !lead.meta.hotAlertSent) {
                    await sendAdminAlert(userPhone, lead, 'Score crossed HOT — tapped Book Call 🔥', clientConfig);
                    lead.meta.hotAlertSent = true;
                    lead.markModified('meta');
                    await lead.save();
                }

                await sendWhatsAppText({
                    phoneNumberId: phoneId, to: userPhone,
                    body: "📞 *Book a Free Strategy Call*\n\nPick a time that works best for you using our calendar link below:\n\n👉 https://calendly.com/moksh-topedgeai/discovery-call\n\n*(Looking forward to speaking with you!)*",
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
                ensureLeadMeta(lead);
                lead.meta.roiStep = 0;
                lead.markModified('meta');
                await lead.save();
                break;

            case 'demo_salon':
                const okSalon = await sendWhatsAppFlow({ phoneNumberId: phoneId, to: userPhone, flowId: SALON_FLOW_ID, body: "💇‍♀️ *Salon Booking Demo*\n\nTest out how users can view services, pick a stylist, and choose a time slot natively.", buttonText: 'Book Salon', screenName: 'SALON_HOME', io, clientConfig });
                if (!okSalon) {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "The native Salon Flow is currently offline for maintenance.", interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'menu_main', title: 'Main Menu' } }] } }, io, clientConfig });
                }
                break;

            case 'demo_turf':
                const okTurf = await sendWhatsAppFlow({ phoneNumberId: phoneId, to: userPhone, flowId: TURF_FLOW_ID, body: "⚽ *Turf Booking Demo*\n\nTest how users can see available courts and book their 1-hour slots quickly.", buttonText: 'Book Turf', screenName: 'TURF_HOME', io, clientConfig });
                if (!okTurf) {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "The native Turf Flow is currently offline for maintenance.", interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'menu_main', title: 'Main Menu' } }] } }, io, clientConfig });
                }
                break;

            case 'demo_clinic':
                const okClinic = await sendWhatsAppFlow({ phoneNumberId: phoneId, to: userPhone, flowId: CLINIC_FLOW_ID, body: "🩺 *Clinic Booking Demo*\n\nTest how patients can complete an intake form and request a doctor consultation natively.", buttonText: 'Book Clinic', screenName: 'CLINIC_HOME', io, clientConfig });
                if (!okClinic) {
                    await sendWhatsAppInteractive({ phoneNumberId: phoneId, to: userPhone, body: "The native Clinic Flow is currently offline for maintenance.", interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'menu_main', title: 'Main Menu' } }] } }, io, clientConfig });
                }
                break;

            case 'demo_ecom':
                // Use the same food catalog demo as routeToIndustryDemo
                await sendWhatsAppImage({ phoneNumberId: phoneId, to: userPhone, imageUrl: LOGO_URL, caption: "Welcome to TopEdge AI E-Commerce 🛒\n\n👇 Explore our digital food catalog and experience smooth ordering:", io, clientConfig });
                await sendWhatsAppInteractive({
                    phoneNumberId: phoneId, to: userPhone,
                    body: "🍔 *Digital Menu & Fast Ordering*\n\nSelect a category to view our mouth-watering options:",
                    interactive: {
                        type: 'list',
                        action: {
                            button: 'View Menu',
                            sections: [{
                                title: 'Categories',
                                rows: [
                                    { id: 'ecom_pizza', title: '🍕 Wood-Fired Pizza', description: 'Freshly baked pizzas' },
                                    { id: 'ecom_burger', title: '🍔 Smash Burgers', description: 'Juicy gourmet burgers' },
                                    { id: 'ecom_pasta', title: '🍝 Fresh Pasta', description: 'Authentic Italian pasta' }
                                ]
                            }]
                        }
                    }, io, clientConfig
                });
                ensureLeadMeta(lead);
                lead.meta.businessVertical = 'ecommerce';
                lead.meta.sessionState = 'viewing_demo';
                lead.markModified('meta');
                await lead.save();
                break;

            // -- INDUSTRY SWITCHER (from post-demo menu) --
            case 'switch_industry':
                ensureLeadMeta(lead);
                lead.meta.businessVertical = null; // Clear so they can re-pick
                lead.meta.sessionState = 'picking_vertical';
                lead.meta.industrySelectContext = 'demo'; // FIX 8: Switching industry = demo context
                lead.markModified('meta');
                await lead.save();

                // FIX 5: Cancel any pending social proof timer
                if (socialProofTimerMap.has(userPhone)) {
                    clearTimeout(socialProofTimerMap.get(userPhone));
                    socialProofTimerMap.delete(userPhone);
                }

                await sendWhatsAppInteractive({
                    phoneNumberId: phoneId, to: userPhone,
                    body: `No problem! Which industry would you like to explore next? 👇`,
                    interactive: {
                        type: 'list',
                        action: {
                            button: 'Select Industry',
                            sections: [{
                                title: 'Pick a Demo',
                                rows: [
                                    { id: 'vert_salon', title: s.salon, description: 'Appointment & booking automation' },
                                    { id: 'vert_turf', title: s.turf, description: 'Slot booking & availability' },
                                    { id: 'vert_clinic', title: s.clinic, description: 'Patient intake & reminders' },
                                    { id: 'vert_ecommerce', title: s.ecommerce, description: 'Order & inquiry automation' }
                                ]
                            }]
                        }
                    },
                    io, clientConfig
                });
                break;

            // -- NOT NOW / MAYBE LATER --
            case 'not_now':
                await sendWhatsAppText({
                    phoneNumberId: phoneId, to: userPhone,
                    body: `No worries! I'll check back in a few hours. 😊\n\nIf you change your mind, just type *Menu* anytime to pick up where you left off.`,
                    io, clientConfig
                });
                break;

            // -- STOP MESSAGES (opt-out) --
            case 'stop_msgs':
                ensureLeadMeta(lead);
                lead.meta.doNotDisturb = true;
                lead.markModified('meta');
                await lead.save();
                clearAllTimers(userPhone);
                await trackEvent(userPhone, EVENTS.OPT_OUT, clientConfig);
                await sendWhatsAppText({
                    phoneNumberId: phoneId, to: userPhone,
                    body: `No problem! You won't hear from me again. 🙏\n\nFeel free to message *Menu* anytime if you change your mind.`,
                    io, clientConfig
                });
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
