const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const { DoctorScheduleOverride } = require('../../models/DoctorScheduleOverride');
const fs = require('fs');
const { getAvailableTimeSlots, createEvent, deleteEvent, findEventsByPhoneNumber } = require('../../utils/googleCalendar');
const { getAvailableDates } = require('../../utils/getAvailableDates');
const { getAvailableSlots } = require('../../utils/getAvailableSlots');
const { sendLeaveConfirmationAndMenu, sendPromptForTimeSlots, sendPartialConfirmationAndMenu } = require('../../utils/step2');
const { sendAdminInitialButtons, sendAdminLeaveDateList } = require('../../utils/Step1');
const { parseDateFromId } = require('../../utils/helpers');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const path = require('path');
const Appointment = require('../../models/Appointment');
const ServiceModel = require('../../models/Service');
const DailyStat = require('../../models/DailyStat');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const { DateTime } = require('luxon');


// Detect greeting words (Standard + Gujinglish)
const GREETING_WORDS = [
  'hi', 'hello', 'hey', 'hii', 'good morning', 'good afternoon', 'good evening', 'greetings',
  'kem cho', 'namaste', 'kemcho', 'majama', 'ram ram', 'jay shree krishna', 'jsk', 'jay swaminarayan',
  'radhe radhe', 'halo', 'tame', 'shubhashbhai'
];

// Add at the top for topic list
const QUESTION_TOPICS = [
  { id: 'ask_services', title: 'Services' },
  { id: 'ask_pricing', title: 'Pricing' },
  { id: 'ask_appointments', title: 'Booking' },
  { id: 'ask_other', title: 'Something else' }
];

const FAQ_DATA = {
  'ask_services': [
    { id: 'faq_serv_types', title: 'What services do you offer?', answer: 'We offer ladies haircuts, advanced hair spa, protein and straightening treatments, global color, highlights, and more. During our 🌈 Holi Sale (24 Mar - 5 Mar), get a FREE Haircut with any Spa, Treatment, or Color! Best services malshe tame! ✨' },
    { id: 'faq_serv_kids', title: 'Do you do kids haircuts?', answer: 'Yes. We provide haircuts for girls of all ages. Chokriyo mate professional cut malshe! 👧' },
    { id: 'faq_serv_color', title: 'Do you do hair color?', answer: 'Yes. We offer professional global color and highlights. 🌈 Holi Special: Get a FREE Haircut with Global/Highlight Color! Perfect color kaam thai jashe! 🎨' },
    { id: 'faq_serv_spa', title: 'Do you offer hair spa?', answer: 'Yes. We have multiple hair spa options. 🌈 Holi Special: Get a FREE Haircut with any Hair Spa starting at just ₹999/-! Hair mate best treatment malshe! 🧖‍♀️' }
  ],
  'ask_pricing': [
    { id: 'faq_price_haircut', title: 'How much is a haircut?', answer: 'Our Haircut is ₹500 and Advance Haircut is ₹700. ✨ Pro Tip: Get it for FREE with any Spa, Treatment, or Color!' },
    { id: 'faq_price_list', title: '🌈 Holi Sale 2026 Price List (24 Mar - 5 Mar)', answer: '✨ *Holi Festive Deals (Includes FREE Haircut)* ✨\n\nHair Spa + 💇‍♀️ FREE Haircut\n• Normal Spa: ₹1500 ❌ ➔ ₹999\n• Loreal Spa: ₹1700 ❌ ➔ ₹1199\n• Silk Protein Spa: ₹2000 ❌ ➔ ₹1499\n• Shea Butter Spa: ₹2500 ❌ ➔ ₹1999\n• Permanent Spa: ₹2500 ❌ ➔ ₹1499\n\nHair Treatment + 💇‍♀️ FREE Haircut\n• Mirror Shine Boto Smooth: ₹4500 ❌ ➔ ₹2999\n• Smoothing: ₹3500 ❌ ➔ ₹2799\n• Nano Therapy: ₹4000 ❌ ➔ ₹3299\n• Botox: ₹3300 ❌ ➔ ₹2499\n\nColour + 💇‍♀️ FREE Haircut\n• Global Hair Color: ₹2500 ❌ ➔ ₹1999\n• Highlight Color: ₹2500 ❌ ➔ ₹1999\n\n*Prices depend on hair length & growth.*' },
    { id: 'faq_price_payment', title: 'Payment Methods', answer: 'We accept Cash, UPI, and all major Credit/Debit cards.' }
  ],
  'ask_appointments': [
    { id: 'faq_appt_book', title: 'How do I book?', answer: 'You can book an appointment directly here. Select "Book Appointment" from the main menu.' },
    { id: 'faq_appt_cancel', title: 'Cancel/Reschedule?', answer: 'To cancel or reschedule, please contact us directly at +91 98244 74547.' },
    { id: 'faq_appt_hours', title: 'Opening Hours?', answer: 'We are open Monday to Sunday, from 10:00 AM to 8:00 PM.' },
    { id: 'faq_appt_advance', title: 'Do I need to book ahead?', answer: 'We recommend booking at least 2 hours in advance to ensure your preferred stylist is available.' }
  ],
  'ask_other': [
    { id: 'faq_other_loc', title: 'Where are you located?', answer: 'We are at Second Floor, Raspan Arcade, 6-7, Raspan Cross Rd, opp. Gokul Party Plot, New India Colony, Nikol, Ahmedabad.' },
    { id: 'faq_other_contact', title: 'Contact Number?', answer: 'You can reach us at +91 98244 74547 for any queries.' },
    { id: 'faq_other_safety', title: 'Safety Measures?', answer: 'We follow strict hygiene protocols, including sanitization of tools and stations after every client.' }
  ]
};

const BirthdayUser = require('../../models/BirthdayUser');

// Load knowledge base for OpenAI
const knowledgeBase = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'knowledgeBase.txt'), 'utf8');

// In-memory state store for user sessions (for MVP; replace with Redis/DB for production)
const userSessions = {};

let waitingForPartial = false;
let partialDate = '';

async function generateWithGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  const resp = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.trim();
}
const salonServices = [
  { id: 'svc_spa_normal', title: 'Normal Spa + FREE Cut', price: '₹999/-', description: '₹1500 ❌ ➔ ₹999 (Holi Offer)', category: 'Hair Spa 🌈' },
  { id: 'svc_spa_loreal', title: 'Loreal Spa + FREE Cut', price: '₹1,199/-', description: '₹1700 ❌ ➔ ₹1199 (Holi Offer)', category: 'Hair Spa 🌈' },
  { id: 'svc_spa_silk', title: 'Protein Spa + FREE Cut', price: '₹1,499/-', description: '₹2000 ❌ ➔ ₹1499 (Holi Offer)', category: 'Hair Spa 🌈' },
  { id: 'svc_spa_shea', title: 'Shea Butter + FREE Cut', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999 (Holi Offer)', category: 'Hair Spa 🌈' },
  { id: 'svc_spa_perm', title: 'Permanent Spa + FREE Cut', price: '₹1,499/-', description: '₹2500 ❌ ➔ ₹1499 (Holi Offer)', category: 'Hair Spa 🌈' },
  { id: 'svc_treat_mirror', title: 'Boto Smooth + FREE Cut', price: '₹2,999/-', description: '₹4500 ❌ ➔ ₹2999 (Holi Offer)', category: 'Treatment 🌈' },
  { id: 'svc_treat_smooth', title: 'Smoothing + FREE Cut', price: '₹2,799/-', description: '₹3500 ❌ ➔ ₹2799 (Holi Offer)', category: 'Treatment 🌈' },
  { id: 'svc_treat_nano', title: 'Nano Therapy + FREE Cut', price: '₹3,299/-', description: '₹4000 ❌ ➔ ₹3299 (Holi Offer)', category: 'Treatment 🌈' },
  { id: 'svc_treat_botox', title: 'Botox + FREE Cut', price: '₹2,499/-', description: '₹3300 ❌ ➔ ₹2499 (Holi Offer)', category: 'Treatment 🌈' },
  { id: 'svc_color_global', title: 'Global Color + FREE Cut', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999 (Holi Offer)', category: 'Colour 🌈' },
  { id: 'svc_color_classic', title: 'Highlight + FREE Cut', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999 (Holi Offer)', category: 'Colour 🌈' },
  { id: 'svc_haircut_basic', title: 'Basic Haircut', price: '₹500/-', description: 'Professional Cut', category: 'Standard' },
  { id: 'svc_haircut_advance', title: 'Advance Haircut', price: '₹700/-', description: 'Stylized Cut', category: 'Standard' }
];

// Real stylists (Female focused)
const salonStylists = [
  { id: 'stylist_shubhashbhai', title: 'Shubhashbhai', description: 'Master Stylist (15+ yrs exp)' },
  { id: 'stylist_hetal', title: 'Hetal', description: 'Senior Hair Specialist' }
];

// Map stylists to their specific Google Calendar IDs
const stylistCalendars = {
  'Shubhashbhai': process.env.GCAL_CALENDAR_ID2,
  'Hetal': process.env.GCAL_CALENDAR_ID,
  'shubhashbhai': process.env.GCAL_CALENDAR_ID2,
  'moksh': process.env.GCAL_CALENDAR_ID,
  'stylist_shubhashbhai': process.env.GCAL_CALENDAR_ID2,
  'stylist_hetal': process.env.GCAL_CALENDAR_ID
};

const salonPricing = [
  { category: 'Holi Special 🌈 (24 Mar - 5 Mar)', service: 'Normal Spa + FREE Haircut', price: '₹1500 ❌ ➔ ₹999' },
  { category: 'Holi Special 🌈', service: 'Loreal Spa + FREE Haircut', price: '₹1700 ❌ ➔ ₹1199' },
  { category: 'Holi Special 🌈', service: 'Protein Spa + FREE Haircut', price: '₹2000 ❌ ➔ ₹1499' },
  { category: 'Holi Special 🌈', service: 'Shea Butter + FREE Haircut', price: '₹2500 ❌ ➔ ₹1999' },
  { category: 'Holi Special 🌈', service: 'Permanent Spa + FREE Haircut', price: '₹2500 ❌ ➔ ₹1499' },
  { category: 'Holi Treatments 🌈', service: 'Boto Smooth + FREE Haircut', price: '₹4500 ❌ ➔ ₹2999' },
  { category: 'Holi Treatments 🌈', service: 'Smoothing + FREE Haircut', price: '₹3500 ❌ ➔ ₹2799' },
  { category: 'Holi Treatments 🌈', service: 'Nano Therapy + FREE Haircut', price: '₹4000 ❌ ➔ ₹3299' },
  { category: 'Holi Treatments 🌈', service: 'Botox + FREE Haircut', price: '₹3300 ❌ ➔ ₹2499' },
  { category: 'Holi Color 🌈', service: 'Global Color + FREE Haircut', price: '₹2500 ❌ ➔ ₹1999' },
  { category: 'Holi Color 🌈', service: 'Highlight + FREE Haircut', price: '₹2500 ❌ ➔ ₹1999' }
];

// Helper to get or initialize user session
function getUserSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = {
      step: 'home',
      data: {}
    };
  }
  return userSessions[userId];
}

// Helper: Save message to DB and emit to Socket.IO
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
    console.error('Error saving/emitting message:', err);
    return null;
  }
}

async function sendWhatsAppText({ phoneNumberId, to, body, token, io, clientId }) {
  if (clientId === 'choice_salon') {
    console.log(`[DEBUG sendWhatsAppText] Token: '${token ? token.substring(0, 15) + '...' : 'undefined'}' (Length: ${token ? token.length : 0})`);
  }

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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    let conversation = await Conversation.findOne({ phone: to, clientId });
    if (!conversation) {
      conversation = await Conversation.create({ phone: to, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
    }

    conversation.lastMessage = body;
    conversation.lastMessageAt = new Date();
    await conversation.save();

    if (io) {
      io.to(`client_${clientId}`).emit('conversation_update', conversation);
    }

    await saveAndEmitMessage({
      clientId,
      from: 'bot',
      to,
      body,
      type: 'text',
      direction: 'outgoing',
      status: 'sent',
      conversationId: conversation._id,
      io
    });

  } catch (err) {
    console.error('Error sending WhatsApp text:', err.response?.data || err.message);
  }
}

async function sendWhatsAppImage({ phoneNumberId, to, imageUrl, caption, token, io, clientId }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: {
      link: imageUrl
    }
  };
  if (caption) {
    data.image.caption = caption;
  }
  try {
    await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    let conversation = await Conversation.findOne({ phone: to, clientId });
    if (!conversation) {
      conversation = await Conversation.create({ phone: to, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
    }

    const lastBody = caption || '[Image]';
    conversation.lastMessage = lastBody;
    conversation.lastMessageAt = new Date();
    await conversation.save();

    if (io) {
      io.to(`client_${clientId}`).emit('conversation_update', conversation);
    }

    await saveAndEmitMessage({
      clientId,
      from: 'bot',
      to,
      body: lastBody,
      type: 'image',
      direction: 'outgoing',
      status: 'sent',
      conversationId: conversation._id,
      io
    });

  } catch (err) {
    console.error('Error sending WhatsApp image:', err.response?.data || err.message);
  }
}

// Helper to send WhatsApp interactive button message
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
  // Remove undefined header if not set
  if (!header) delete data.interactive.header;
  try {
    await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    let conversation = await Conversation.findOne({ phone: to, clientId });
    if (!conversation) {
      conversation = await Conversation.create({ phone: to, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
    }

    conversation.lastMessage = body;
    conversation.lastMessageAt = new Date();
    await conversation.save();

    if (io) {
      io.to(`client_${clientId}`).emit('conversation_update', conversation);
    }

    await saveAndEmitMessage({
      clientId,
      from: 'bot',
      to,
      body,
      type: 'interactive',
      direction: 'outgoing',
      status: 'sent',
      conversationId: conversation._id,
      io
    });

  } catch (err) {
    console.error('Error sending WhatsApp buttons:', err.response?.data || err.message);
  }
}

// Helper to send WhatsApp interactive list message (for day selection)
async function sendWhatsAppList({ phoneNumberId, to, header, body, button, rows, token, io, clientId, footer, imageHeader }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  // Enforce WhatsApp max 10 rows per section
  let safeRows = rows;
  if (rows.length > 10) {
    console.warn('sendWhatsAppList: Truncating rows to 10 due to WhatsApp API limit.');
    safeRows = rows.slice(0, 10);
  }
  const data = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: imageHeader ? { type: 'image', image: { link: imageHeader } } : (header ? { type: 'text', text: header } : undefined),
      body: { text: body },
      footer: footer ? { text: footer } : (true ? { text: 'Choice Salon Holi Offer 🌈' } : { text: 'Choice Salon for Ladies 💅' }),
      action: {
        button,
        sections: [
          {
            title: 'Available Options',
            rows: safeRows.map(r => {
              // WhatsApp limit for row title is 24 characters
              let finalTitle = r.title || '';
              if (finalTitle.length > 24) {
                finalTitle = finalTitle.substring(0, 21) + '...';
              }
              const row = { id: r.id, title: finalTitle };
              if (r.description) row.description = r.description;
              return row;
            })
          }
        ]
      }
    }
  };
  if (!header) delete data.interactive.header;
  try {
    await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    let conversation = await Conversation.findOne({ phone: to, clientId });
    if (!conversation) {
      conversation = await Conversation.create({ phone: to, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
    }

    const content = body || 'List';
    conversation.lastMessage = content;
    conversation.lastMessageAt = new Date();
    await conversation.save();

    if (io) {
      io.to(`client_${clientId}`).emit('conversation_update', conversation);
    }

    await saveAndEmitMessage({
      clientId,
      from: 'bot',
      to,
      body: content,
      type: 'interactive',
      direction: 'outgoing',
      status: 'sent',
      conversationId: conversation._id,
      io
    });

  } catch (err) {
    console.error('Error sending WhatsApp list:', err.response?.data || err.message);
  }
}

// Utility: Send buttons or list depending on count
async function sendSmartButtonsOrList({ phoneNumberId, to, header, body, buttons, fallbackButtonLabel = 'Select Option', token, io, clientId }) {
  if (buttons.length > 3) {
    // Use WhatsApp list message
    await sendWhatsAppList({
      phoneNumberId,
      to,
      header,
      body,
      button: fallbackButtonLabel,
      rows: buttons.map(({ id, title }) => ({ id, title })),
      token,
      io,
      clientId
    });
  } else {
    // Use WhatsApp button message
    await sendWhatsAppButtons({
      phoneNumberId,
      to,
      header,
      body,
      buttons,
      token,
      io,
      clientId
    });
  }
}

// Helper: get available booking days (dynamic, based on Google Calendar availability)
async function getAvailableBookingDays(stylist, calendars) {
  try {
    // Normalize stylist name to match config keys (e.g., "Stylist Hetal" -> "stylist_hetal")
    const stylistKey = stylist.toLowerCase().replace(/\s+/g, '_');
    const calendarId = calendars[stylistKey] || calendars[stylist];
    console.log(`🔍 Fetching dynamic available dates from Google Calendar for ${stylist} (key: ${stylistKey})...`, calendarId);

    if (!calendarId) {
      console.log('❌ No calendar ID found for stylist:', stylist);
      return [];
    }

    const availableDates = await getAvailableDates(8, calendarId);

    if (availableDates.length === 0) {
      console.log('❌ No available dates found, returning empty array');
      return [];
    }

    console.log(`✅ Found ${availableDates.length} available dates for booking`);
    return availableDates;
  } catch (error) {
    console.error('❌ Error getting available dates:', error);
    // Fallback to static dates if dynamic fetch fails
    const days = [];
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const businessStart = new Date(now);
    businessStart.setHours(7, 0, 0, 0);
    const businessEnd = new Date(now);
    businessEnd.setHours(18, 0, 0, 0);
    let startOffset = 0;
    if (now < businessStart || now >= businessEnd) {
      startOffset = 1;
    }
    for (let i = startOffset; days.length < 7; i++) {
      const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      if (d.getDay() === 0) continue;
      const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
      days.push({ id: `calendar_day_${days.length}`, title: label });
    }
    return days;
  }
}

// Helper function to get paginated services
function getPaginatedServices(page = 0) {
  const servicesPerPage = 8; // Show 8 services + "Ask Stylist" + "Choose Another Service"
  const startIndex = page * servicesPerPage;
  const endIndex = startIndex + servicesPerPage;
  const pageServices = salonServices.slice(startIndex, endIndex);

  // Add "Ask Stylist" option
  pageServices.push({ id: 'service_ask_stylist', title: 'Ask Stylist' });

  // Add "Choose Another Service" if there are more services
  if (endIndex < salonServices.length) {
    pageServices.push({ id: 'service_more', title: 'More Services' });
  }

  return {
    services: pageServices,
    currentPage: page,
    totalPages: Math.ceil(salonServices.length / servicesPerPage),
    hasMore: endIndex < salonServices.length
  };
}

// Helper: get available time slots for a given date with pagination
async function fetchRealTimeSlots(dateStr, page = 0, stylist, calendars) {
  try {
    // Normalize stylist name
    const stylistKey = stylist.toLowerCase().replace(/\s+/g, '_');
    const calendarId = calendars[stylistKey] || calendars[stylist];
    console.log(`🔍 Fetching available slots for ${dateStr} (page ${page}) with stylist ${stylist} (key: ${stylistKey})...`);

    if (!calendarId) {
      console.error(`No calendar ID configured for stylist: ${stylist} (key: ${stylistKey})`);
      return { slots: [], totalSlots: 0, currentPage: 0, totalPages: 0, hasMore: false };
    }

    const result = await getAvailableSlots(dateStr, page, calendarId);

    if (result.totalSlots === 0) {
      console.log(`❌ No available slots found for ${dateStr}`);
      return {
        slots: [],
        totalSlots: 0,
        currentPage: 0,
        totalPages: 0,
        hasMore: false
      };
    }

    console.log(`✅ Found ${result.totalSlots} available slots for ${dateStr} (page ${result.currentPage + 1}/${result.totalPages})`);

    return result;
  } catch (err) {
    console.error('Error fetching real time slots:', err);
    return {
      slots: [],
      totalSlots: 0,
      currentPage: 0,
      totalPages: 0,
      hasMore: false
    };
  }
}

// Helper: Notify admins (dynamic)
async function notifyAdmins({ phoneNumberId, message, adminNumbers, token, clientId, io }) {
  for (const adminPhone of adminNumbers) {
    await sendWhatsAppText({
      phoneNumberId,
      to: adminPhone,
      body: message,
      token,
      io,
      clientId
    });
  }
}

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, clientConfig, io }) {
  // Extract client config
  const { whatsappToken: token, geminiApikey, config, clientId } = clientConfig;
  // Merge DB config calendars with local hardcoded/env calendars
  const calendars = { ...stylistCalendars, ...(config.calendars || {}) };
  const adminNumbers = config.adminPhones || (config.adminPhone ? [config.adminPhone] : []);
  const geminiKey = geminiApikey || process.env.GEMINI_API_KEY;

  const session = getUserSession(from);
  const userMsgType = messages.type;
  const userMsg = userMsgType === 'interactive' ? (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id) : messages.text?.body;

  // Pass common params to helpers
  const helperParams = { phoneNumberId, token, io, clientId };

  // Track lead interaction for Active Leads display
  try {
    await AdLead.updateOne(
      { clientId, phoneNumber: from },
      {
        $set: {
          lastInteraction: new Date(),
          chatSummary: userMsg ? userMsg.substring(0, 50) : 'Interaction'
        },
        $setOnInsert: { source: 'WhatsApp', leadScore: 10 }
      },
      { upsert: true }
    );
  } catch (e) {
    console.error('AdLead update error:', e);
  }

  // Handle STOP/UNSUBSCRIBE commands
  if (userMsgType === 'text' && userMsg && (userMsg.trim().toLowerCase() === 'stop' || userMsg.trim().toLowerCase() === 'unsubscribe')) {

    try {
      // Update BirthdayUser collection
      await BirthdayUser.updateOne(
        { number: from },
        {
          $set: {
            isOpted: false,
            optedOutOn: new Date().toISOString()
          }
        },
        { upsert: true }
      );

      // Update all appointments for this user to opt out of reminders
      await Appointment.updateMany(
        { phone: from },
        {
          $set: {
            'consent.appointmentReminders': false,
            'consent.birthdayMessages': false,
            'consent.marketingMessages': false,
            'consent.consentedAt': new Date()
          }
        }
      );

      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: '✅ You have been unsubscribed from all appointment reminders and birthday messages. You will no longer receive any messages from us. If you change your mind, you can opt back in by sending "START" to this number.'
      });

      // Clear any existing session
      delete userSessions[from];
      res.status(200).end();
      return;
    } catch (err) {
      console.error('Error processing unsubscribe request:', err);
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: '⚠️ We encountered an error processing your request. Please try again later or contact support.'
      });
      res.status(200).end();
      return;
    }
  }

  // Handle START command to re-subscribe
  if (userMsgType === 'text' && userMsg && userMsg.trim().toLowerCase() === 'start') {
    try {
      // Update BirthdayUser collection
      await BirthdayUser.updateOne(
        { number: from },
        {
          $set: {
            isOpted: true
          },
          $unset: { optedOutOn: 1 }
        },
        { upsert: true }
      );

      // Update all appointments for this user to opt in to reminders
      await Appointment.updateMany(
        { phone: from },
        {
          $set: {
            'consent.appointmentReminders': true,
            'consent.birthdayMessages': true,
            'consent.marketingMessages': false, // No marketing messages
            'consent.consentedAt': new Date()
          }
        }
      );

      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: '✅ You have been successfully resubscribed to appointment reminders and birthday messages. Welcome back! 🎉'
      });

      // Clear any existing session
      delete userSessions[from];
      res.status(200).end();
      return;
    } catch (err) {
      console.error('Error processing subscribe request:', err);
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: '⚠️ We encountered an error processing your request. Please try again later or contact support.'
      });
      res.status(200).end();
      return;
    }
  }

  // If user sends a greeting, always show the main menu with buttons
  if (userMsgType === 'text' && userMsg && GREETING_WORDS.some(w => userMsg.trim().toLowerCase().startsWith(w))) {
    await sendWhatsAppButtons({
      ...helperParams,
      to: from,
      imageHeader: 'https://instagram.famd1-2.fna.fbcdn.net/v/t51.2885-19/436333745_1497177940869325_2985750738127060080_n.jpg?efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLmRqYW5nby4xMDgwLmMyIn0&_nc_ht=instagram.famd1-2.fna.fbcdn.net&_nc_cat=101&_nc_oc=Q6cZ2QH8vCGf2jGUX3lSsvjRV2axzhtJLYNHfIbhUn1TQkvNKEvnx4XWgdyKCrgXVx8KsC9Pq5Fgfk9UcjXn18wL8ThL&_nc_ohc=8-CBI_zJuBwQ7kNvwEeJ635&_nc_gid=Gp62ZusslBSvo5TFvcyJAg&edm=ALGbJPMBAAAA&ccb=7-5&oh=00_AftGK8L_C4HRW6SdWj31MRppEsoQ-N4fEB14vEohvB7zrA&oe=69A1B22C&_nc_sid=7d3ac5',
      body: 'Hi 👋\n\nThis is Shubhashbhai from Choice Salon! ✨ Celebrate Holi with our exclusive deals (24 Mar - 5 Mar)!\n\n🎁 *Holi Special:* Get a *FREE HAIRCUT* with any Spa, Treatment, or Color service! 💇‍♀️\n\nHow can I help you today? ✨',
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Holi Offer 📅' },
        { id: 'user_pricing', title: 'Offer Price List 💰' },
        { id: 'user_ask_question', title: 'Ask a Question ❓' }
      ]
    });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }

  // -----------------------------------------------------------
  // FAQ FLOW HANDLERS (Pre-filled Questions)
  // -----------------------------------------------------------

  // Step: User selected a FAQ Topic (e.g., 'ask_services')
  if (session.step === 'ask_question_topic') {
    const topicKey = userMsg;

    // Check if valid topic (button click)
    if (FAQ_DATA[topicKey]) {
      const questions = FAQ_DATA[topicKey];
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Frequently Asked Questions',
        body: `Here are some common questions about ${QUESTION_TOPICS.find(t => t.id === topicKey)?.title || 'this topic'}. Select one to see the answer:`,
        footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
        button: 'Select Question',
        rows: questions.map(q => ({ id: q.id, title: q.title }))
      });
      session.step = 'faq_question_select';
      session.data.faqTopic = topicKey;
      res.status(200).end();
      return;
    }

    // If user typed text or sent invalid input, guide them back
    await sendWhatsAppList({
      ...helperParams,
      to: from,
      header: 'Ask a Question ❓',
      body: 'Please select a topic from the list below to get the best answer:',
      button: 'Select Topic',
      rows: QUESTION_TOPICS
    });
    // Keep step as ask_question_topic
    res.status(200).end();
    return;
  }

  // Step: User selected a specific Question
  if (session.step === 'faq_question_select') {
    // Find the answer
    let answer = null;
    let questionTitle = '';

    // Search in current topic or all
    for (const key in FAQ_DATA) {
      const q = FAQ_DATA[key].find(item => item.id === userMsg);
      if (q) {
        answer = q.answer;
        questionTitle = q.title;
        break;
      }
    }

    if (answer) {
      // Send answer
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: `*${questionTitle}*\n\n${answer}`
      });

      // Follow up
      await sendSmartButtonsOrList({
        ...helperParams,
        to: from,
        header: undefined,
        body: 'Is there anything else I can help you with?',
        buttons: [
          { id: 'user_ask_question', title: 'Ask Another Question' },
          { id: 'user_schedule_appt', title: 'Book Appointment' },
          { id: 'user_home', title: 'Main Menu' }
        ]
      });
      session.step = 'home_waiting';
      res.status(200).end();
      return;
    }

    // Invalid selection or text - re-show questions for the topic
    const topicKey = session.data.faqTopic;
    if (topicKey && FAQ_DATA[topicKey]) {
      const questions = FAQ_DATA[topicKey];
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Select a Question',
        body: 'Please select one of the questions below:',
        button: 'Select Question',
        rows: questions.map(q => ({ id: q.id, title: q.title }))
      });
      res.status(200).end();
      return;
    } else {
      // Fallback to topics if state is lost
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Ask a Question ❓',
        body: 'Please select a topic:',
        button: 'Select Topic',
        rows: QUESTION_TOPICS
      });
      session.step = 'ask_question_topic';
      res.status(200).end();
      return;
    }
  }

  // AI-powered free-text handling (not a button/list reply)
  if (userMsgType === 'text' && (!session.step || session.step === 'home' || session.step === 'home_waiting' || session.step === 'faq_menu' || session.step === 'appt_day' || session.step === 'appt_pick_day_waiting' || session.step === 'appt_time_waiting' || session.step === 'ask_question_topic' || session.step === 'faq_await')) {

    // Check if user is explicitly trying to book an appointment via text
    const bookingKeywords = [
      'book appointment',
      'make appointment',
      'schedule appointment',
      'book visit',
      'see stylist',
      'book salon session',
      'appointment book kar',
      'book karvu',
      'booking kar',
      'time book',
      'slot book',
      'haircut karvu',
      'spa karvu',
      'color karvu',
      'treatment karvu',
      'appoinment',
      'booking chhe'
    ];
    const userMsgLower = userMsg.toLowerCase();
    const isExplicitBooking = bookingKeywords.some(keyword => userMsgLower.includes(keyword));

    // If user is in FAQ/Ask Question flow, don't trigger booking automatically
    if (session.step === 'ask_question_topic' || session.step === 'faq_await') {
      // Handle as a general question, not booking
      console.log('User in FAQ flow, handling as question');
    } else if (isExplicitBooking) {
      // Start the booking flow directly
      const paginatedServices = getPaginatedServices(0);
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Book Appointment 💇‍♀️',
        body: 'Perfect! I’d be happy to help you book an appointment. 😊 Which service do you need?',
        button: 'Select Service',
        rows: paginatedServices.services
      });
      session.step = 'choose_service';
      session.data.servicePage = 0;
      res.status(200).end();
      return;
    }
    // Enhanced OpenAI prompt for precise, human-like responses (Ladies Only Salon)
    const prompt = `You are a friendly and professional salon assistant for Choice Salon for Ladies in Ahmedabad.
    
    IMPORTANT INSTRUCTIONS:
    1. Choice Salon is EXCLUSIVELY for ladies. Do NOT mention or offer any male services (like shaving, beard trimming, etc.).
    2. Use the knowledge base below to provide accurate, helpful information.
    3. Keep responses SHORT and PRECISE (max 2-3 sentences).
    4. Be conversational, warm, and feminine in tone. Use 1-2 relevant emojis ✨💇‍♀️.
    5. If asked about services: Mention Haircuts, Hair Spa, Facials, Color, Pedicure, Threading, and Waxing.
    6. If asked about pricing: Mention 2-3 top services (e.g., Haircut ₹500, Hair Spa ₹1500).
    7. If asked about hours: "We're open Monday-Sunday, 10 AM to 8 PM".
    8. If question is NOT about salon services: Politely redirect to salon topics.
    9. End with a simple "How else can I pamper you today? ✨" or "Need help booking? 😊"
    
    KNOWLEDGE BASE:
    ${knowledgeBase}
    
    USER QUESTION: ${userMsg}
    
    Provide a SHORT, PRECISE response:`;

    let aiResponse = '';
    try {
      aiResponse = await generateWithGemini(geminiKey, prompt);
      if (!aiResponse.toLowerCase().includes('need anything else') &&
        !aiResponse.toLowerCase().includes('anything else') &&
        !aiResponse.toLowerCase().includes('help you') &&
        !aiResponse.toLowerCase().includes('assistance')) {
        aiResponse += '\n\nNeed anything else I can help you with?';
      }
    } catch (err) {
      console.error('Gemini API error:', err);
      aiResponse = "I'm having trouble accessing information right now. Please try again, or use the buttons below.";
    }

    // Always append the two main buttons
    await sendSmartButtonsOrList({
      ...helperParams,
      to: from,
      header: undefined,
      body: aiResponse,
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Appointment' },
        { id: 'user_ask_question', title: 'Ask a Question' }
      ]
    });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }

  // Allow restart at any point
  if (userMsg === 'user_home' || userMsg === 'faq_home') {
    session.step = 'home';
    await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
    return;
  }

  // Home menu (step: 'home')
  // Handle global buttons (Home, Book Another, Ask Question)
  if (userMsg === 'user_home' || userMsg === 'home') {
    session.step = 'home';
    session.data = {};
    await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
    return;
  }

  if (userMsg === 'book_another') {
    session.step = 'choose_service';
    session.data = { servicePage: 0 };
    const paginatedServices = getPaginatedServices(0);
    await sendWhatsAppList({
      ...helperParams,
      to: from,
      header: 'Book Appointment 💇‍♀️',
      body: 'Which service would you like to book?',
      button: 'Select Service',
      rows: paginatedServices.services
    });
    res.status(200).end();
    return;
  }

  if (userMsg === 'user_ask_question') {
    await sendWhatsAppList({
      ...helperParams,
      to: from,
      header: 'Ask a Question ❓',
      body: 'Please select a topic for your question:',
      button: 'Select Topic',
      rows: QUESTION_TOPICS
    });
    session.step = 'ask_question_topic';
    res.status(200).end();
    return;
  }

  if (!session.step || session.step === 'home') {
    await sendWhatsAppButtons({
      ...helperParams,
      to: from,
      imageHeader: 'https://instagram.famd1-2.fna.fbcdn.net/v/t51.2885-19/436333745_1497177940869325_2985750738127060080_n.jpg?efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLmRqYW5nby4xMDgwLmMyIn0&_nc_ht=instagram.famd1-2.fna.fbcdn.net&_nc_cat=101&_nc_oc=Q6cZ2QH8vCGf2jGUX3lSsvjRV2axzhtJLYNHfIbhUn1TQkvNKEvnx4XWgdyKCrgXVx8KsC9Pq5Fgfk9UcjXn18wL8ThL&_nc_ohc=8-CBI_zJuBwQ7kNvwEeJ635&_nc_gid=Gp62ZusslBSvo5TFvcyJAg&edm=ALGbJPMBAAAA&ccb=7-5&oh=00_AftGK8L_C4HRW6SdWj31MRppEsoQ-N4fEB14vEohvB7zrA&oe=69A1B22C&_nc_sid=7d3ac5',
      body: 'Hi 👋\n\nThis is Shubhashbhai from Choice Salon! ✨ Celebrate Holi with our exclusive deals (24 Mar - 5 Mar)!\n\n🎁 *Holi Special:* Get a *FREE HAIRCUT* with any Spa, Treatment, or Color service! 💇‍♀️\n\nHow can I help you today? ✨',
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Holi Offer 📅' },
        { id: 'user_pricing', title: 'Offer Price List 💰' },
        { id: 'user_ask_question', title: 'Ask a Question ❓' }
      ]
    });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }

  // Home menu response
  if (session.step === 'home_waiting') {
    if (userMsg === 'user_schedule_appt') {
      // Always start with service selection - first page
      const paginatedServices = getPaginatedServices(0);
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Book Appointment 💇‍♀️',
        body: 'Which service would you like to book?',
        button: 'Select Service',
        rows: paginatedServices.services
      });
      session.step = 'choose_service';
      session.data.servicePage = 0;
      res.status(200).end();
      return;
    } else if (userMsg === 'user_cancel_appt' || userMsg === 'user_reschedule_appt') {
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: 'To cancel or reschedule your appointment, please contact us at +91 98244 74547. Thank you! 😊'
      });
      session.step = 'home';
      res.status(200).end();
      return;
    } else if (userMsg === 'user_ask_question' || session.step === 'ask_question_topic') {
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Ask a Question ❓',
        body: 'Please select a topic for your question:',
        button: 'Select Topic',
        rows: QUESTION_TOPICS
      });
      session.step = 'ask_question_topic';
      res.status(200).end();
      return;
    } else if (userMsg === 'user_pricing') {
      await sendWhatsAppImage({
        ...helperParams,
        to: from,
        imageUrl: 'https://i.ibb.co/RpDZnkrZ/choice-salon.png',
        caption: 'Choice Salon Services & Pricing'
      });
      res.status(200).end();
      return;
    } else {
      // Fallback for unexpected input (max 3 buttons)
      await sendSmartButtonsOrList({
        ...helperParams,
        to: from,
        header: 'Oops! I didn’t catch that 🙈',
        body: 'Please use the buttons below so I can guide you better:',
        buttons: [
          { id: 'user_schedule_appt', title: 'Book Appointment' },
          { id: 'user_ask_question', title: 'Ask a Question' },
          { id: 'user_home', title: 'Start Over' }
        ]
      });
      session.step = 'home_waiting';
      res.status(200).end();
      return;
    }
  }

  if (session.step === 'choose_service') {
    // Handle pagination for services
    if (userMsg === 'service_more') {
      // Show next page of services
      const nextPage = (session.data.servicePage || 0) + 1;
      const paginatedServices = getPaginatedServices(nextPage);

      if (paginatedServices.services.length > 0) {
        // Add "Back" button to the services list
        const servicesWithBack = [...paginatedServices.services];
        servicesWithBack.unshift({ id: 'service_back', title: '🔙 Back' });

        await sendWhatsAppList({
          ...helperParams,
          to: from,
          header: 'Book Appointment',
          body: 'Choose from more services:',
          button: 'Select Service',
          rows: servicesWithBack
        });
        session.data.servicePage = nextPage;
        session.step = 'choose_service';
        res.status(200).end();
        return;
      }
    }

    // Handle going back to previous page
    if (userMsg === 'service_back') {
      const prevPage = Math.max((session.data.servicePage || 0) - 1, 0);
      const paginatedServices = getPaginatedServices(prevPage);

      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Book Appointment',
        body: prevPage === 0 ? 'Which service do you need?' : 'Choose from services:',
        button: 'Select Service',
        rows: paginatedServices.services
      });
      session.data.servicePage = prevPage;
      session.step = 'choose_service';
      res.status(200).end();
      return;
    }

    // Handle "Ask Stylist" option
    if (userMsg === 'service_ask_stylist') {
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: 'I\'ll connect you with our stylist for a personalized session. Please provide your name and we\'ll schedule it for you.'
      });
      session.data.chosenService = 'Stylist Session';
      session.step = 'appt_name';
      res.status(200).end();
      return;
    }

    const chosen = salonServices.find(s => s.id === userMsg || s.title.toLowerCase() === (userMsg || '').toLowerCase());
    if (chosen) {
      session.data.chosenService = chosen.title;
      session.data.chosenCategory = chosen.category;
      session.data.chosenPrice = chosen.price;
      await sendSmartButtonsOrList({
        ...helperParams,
        to: from,
        header: `${chosen.title} – ${chosen.price}`,
        footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
        body: `For ${chosen.title}, from which stylist would you prefer?`,
        footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
        buttons: salonStylists.map(s => ({ id: s.id, title: s.title }))
      });
      session.step = 'choose_stylist';
      res.status(200).end();
      return;
    } else {
      // Fallback: show current page of services again
      const currentPage = session.data.servicePage || 0;
      const paginatedServices = getPaginatedServices(currentPage);
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Book Appointment',
        body: 'Please select a service:',
        button: 'What to book?',
        rows: paginatedServices.services
      });
      session.step = 'choose_service';
      res.status(200).end();
      return;
    }
  }

  // Step 3: Stylist selection
  if (session.step === 'choose_stylist') {
    const chosen = salonStylists.find(d => d.id === userMsg || d.title.toLowerCase() === (userMsg || '').toLowerCase());
    if (chosen) {
      session.data.stylist = chosen.title;
      session.data.stylistId = chosen.id; // Store ID for calendar lookup
      // Step 4: Date selection
      const days = await getAvailableBookingDays(session.data.stylistId, calendars);

      // Clean up the days array to only include WhatsApp-compatible properties
      const cleanDays = days.map(day => ({
        id: day.id,
        title: day.title
      }));

      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: `Choose a date for your appointment`,
        body: 'Please select a day:',
        button: 'Select Day',
        rows: cleanDays
      });
      session.data.calendarDays = days; // Keep full data in session
      session.step = 'calendar_pick_day';
      res.status(200).end();
      return;
    } else {
      // Fallback: show stylist list again
      await sendSmartButtonsOrList({
        ...helperParams,
        to: from,
        header: `Great! Which stylist would you prefer?`,
        body: 'Choose your stylist:',
        buttons: salonStylists.map(s => ({ id: s.id, title: s.title }))
      });
      session.step = 'choose_stylist';
      res.status(200).end();
      return;
    }
  }

  // Step 4: Date selection (calendar_pick_day)
  if (session.step === 'calendar_pick_day') {
    let date = '';
    const page = session.data.slotPage || 0; // Always define page at the top
    if (userMsg && userMsg.startsWith('calendar_day_')) {
      const idx = parseInt(userMsg.replace('calendar_day_', ''), 10);
      const picked = session.data.calendarDays && session.data.calendarDays[idx] ? session.data.calendarDays[idx].title : '';
      if (picked) {
        date = picked;
      }
    } else if (session.data.calendarDays) {
      const match = session.data.calendarDays.find(day => day.title.toLowerCase() === (userMsg || '').toLowerCase());
      if (match) {
        date = match.title;
      }
    }
    if (date || session.data.date) {
      // If a new date is selected, use it; otherwise, use the last selected date
      const selectedDate = date || session.data.date;
      session.data.date = selectedDate;
      let slotResult = [];
      try {
        const page = session.data.slotPage || 0;
        slotResult = await fetchRealTimeSlots(selectedDate, page, session.data.stylistId || session.data.stylist, calendars);
        if (!slotResult.slots || slotResult.slots.length === 0) {
          // Check if this is today and provide a more helpful message
          const nowIST = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
          const today = new Date(nowIST).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });

          if (selectedDate.toLowerCase().includes(today.toLowerCase())) {
            await sendWhatsAppText({
              ...helperParams,
              to: from,
              body: 'Sorry, there are no available slots for today. This could be because:\n\n• All slots have already passed\n• We need at least 30 minutes advance notice for bookings\n• The salon is closed for today\n\nPlease try selecting a different date! 😊'
            });
          } else {
            await sendWhatsAppText({
              ...helperParams,
              to: from,
              body: 'Sorry, there are no available slots for this date. Please try selecting a different day! 😊'
            });
          }
          session.step = 'calendar_pick_day';
          res.status(200).end();
          return;
        }
      } catch (err) {
        console.error('Error fetching slots:', err);
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Sorry, we could not fetch available slots from our calendar. Please try again later.'
        });
        session.step = 'home';
        res.status(200).end();
        return;
      }
      // Use the new slot format with proper IDs, only send id and title
      let buttons = slotResult.slots.map(slot => ({
        id: slot.id,
        title: slot.title
      }));
      // Add navigation buttons
      if (slotResult.hasMore) {
        buttons.push({ id: 'slot_next', title: 'Show More Slots' });
      }
      if (page > 0) {
        buttons.unshift({ id: 'slot_prev', title: 'Previous' });
      }
      buttons.push({ id: 'back_date', title: 'Back' });
      await sendSmartButtonsOrList({
        ...helperParams,
        to: from,
        header: `Available time slots for ${selectedDate}:`,
        body: 'Pick a time:',
        buttons
      });
      // Store slot data for later use
      session.data.slotResult = slotResult;
      session.step = 'choose_time';
      res.status(200).end();
      return;
    } else {
      // fallback: show calendar days again
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Pick a date',
        body: 'Please select a day for your appointment:',
        button: 'Select Day',
        rows: session.data.calendarDays ? session.data.calendarDays.map(day => ({ id: day.id, title: day.title })) : []
      });
      session.step = 'calendar_pick_day';
      res.status(200).end();
      return;
    }
  }

  // Step 5: Time slot selection (choose_time)
  if (session.step === 'choose_time') {
    let time = '';
    let selectedSlot = null;
    // Support slot pagination and selection
    if (userMsg && userMsg.startsWith('slot_')) {
      if (userMsg.startsWith('slot_next')) {
        // Handle any slot_next_* ID
        const currentPage = session.data.slotPage || 0;
        session.data.slotPage = currentPage + 1;
        session.step = 'calendar_pick_day';
        await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
        return;
      } else if (userMsg === 'slot_prev') {
        session.data.slotPage = Math.max((session.data.slotPage || 0) - 1, 0);
        session.step = 'calendar_pick_day';
        await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
        return;
      } else {
        // Handle slot selection - find the selected slot
        selectedSlot = session.data.slotResult.slots.find(slot => slot.id === userMsg);
        if (selectedSlot && selectedSlot.slot) {
          time = selectedSlot.slot.displayTime; // Use the display time (e.g., "7:00 AM")
        }
      }
    } else if (userMsg === 'back_date') {
      session.step = 'calendar_pick_day';
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
      return;
    } else if (session.data.slotResult && session.data.slotResult.slots) {
      // Handle text-based slot selection
      const match = session.data.slotResult.slots.find(slot =>
        slot.title.toLowerCase() === (userMsg || '').toLowerCase()
      );
      if (match && match.slot) {
        selectedSlot = match;
        time = match.slot.displayTime;
      }
    }
    if (time) {
      session.data.time = time;
      session.data.selectedSlot = selectedSlot; // Store the full slot data for booking
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: `You chose:\nDate: ${session.data.date}\nTime: ${time}\n\nPlease share your full name to confirm the booking.`
      });
      session.step = 'appt_name';
      res.status(200).end();
      return;
    } else {
      // Fallback: show time slots again (with pagination)
      const slotResult = session.data.slotResult;
      if (!slotResult || !slotResult.slots) {
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Sorry, no slots available. Please try a different date.'
        });
        session.step = 'home';
        res.status(200).end();
        return;
      }
      // Only send id and title for WhatsApp list
      let buttons = slotResult.slots.map(slot => ({
        id: slot.id,
        title: slot.title
      }));
      // Add navigation buttons
      if (slotResult.hasMore) {
        buttons.push({ id: 'slot_next', title: 'Show More Slots' });
      }
      if (session.data.slotPage > 0) {
        buttons.unshift({ id: 'slot_prev', title: 'Previous' });
      }
      buttons.push({ id: 'back_date', title: 'Back' });
      await sendSmartButtonsOrList({
        ...helperParams,
        to: from,
        header: `Available time slots for ${session.data.date}:`,
        footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
        body: 'Pick a time:',
        buttons
      });
      session.step = 'choose_time';
      res.status(200).end();
      return;
    }
  }

  // Appointment: Collect name (free text)
  if (session.step === 'appt_name') {
    if (userMsgType === 'text' && userMsg && userMsg.length > 1) {
      session.data.name = userMsg;
      // Use the WhatsApp 'from' field as the phone number
      session.data.phone = from;

      // Check if user has previous consent history
      try {
        const previousAppointments = await Appointment.find({
          phone: session.data.phone
        }).sort({ createdAt: -1 }).limit(1);

        if (previousAppointments.length > 0) {
          const lastAppointment = previousAppointments[0];
          const hasConsentHistory = lastAppointment.consent && lastAppointment.consent.consentedAt;

          if (hasConsentHistory) {
            // User has previous consent - show direct confirmation
            let consentStatus = '';
            let confirmationBody = `✅ *Booking Summary*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n�‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n💅 *Service:* ${session.data.chosenService || 'General Salon Session'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\n`;

            if (lastAppointment.consent.appointmentReminders && lastAppointment.consent.birthdayMessages) {
              consentStatus = '✅ Accept All';
              confirmationBody += `• Booking reminders & Birthday wishes 🎂\n\n*Using your previous preference: Accept All*`;
            } else if (lastAppointment.consent.appointmentReminders) {
              consentStatus = '📅 Reminders Only';
              confirmationBody += `• Booking reminders only 📅\n\n*Using your previous preference: Reminders Only*`;
            } else {
              consentStatus = '❌ No Thanks';
              confirmationBody += `• No communications ❌\n\n*Using your previous preference: No Thanks*`;
            }

            // Store the previous consent for this booking
            session.data.consent = {
              appointmentReminders: lastAppointment.consent.appointmentReminders,
              birthdayMessages: lastAppointment.consent.birthdayMessages,
              marketingMessages: false,
              consentedAt: new Date(),
              reusedFromPrevious: true
            };

            console.log(`🔄 Using previous consent for user ${session.data.phone}: ${consentStatus}`);

            // Send direct confirmation with previous consent
            await sendWhatsAppButtons({
              ...helperParams,
              to: from,
              header: 'Confirm Booking',
              body: confirmationBody,
              buttons: [
                { id: 'confirm_with_previous_consent', title: 'Confirm' },
                { id: 'change_consent_preferences', title: 'Change' }
              ]
            });
            session.step = 'appt_confirm_with_previous_consent';
            res.status(200).end();
            return;
          }
        }

        // No previous consent or first-time user - show consent options
        await sendWhatsAppButtons({
          ...helperParams,
          to: from,
          header: 'Booking Summary',
          body: `✨ *Review Your Holi Booking* ✨

👤 *Client:* ${session.data.name}
📅 *Date:* ${session.data.date}
🕒 *Time:* ${session.data.time}
💇‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}
💅 *Service:* ${session.data.chosenService || 'General Salon Session'}

📱 *Contact:* ${session.data.phone}

*Please choose your communication preference below:*`,
          footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
          buttons: [
            { id: 'consent_confirm_all', title: '✅ Accept All' },
            { id: 'consent_reminders_only', title: '📅 Reminders Only' },
            { id: 'consent_none', title: '❌ No Thanks' }
          ]
        });
        session.step = 'appt_consent';
        res.status(200).end();
        return;

      } catch (error) {
        console.error('Error checking previous consent:', error);
        // Fallback to showing consent options
        await sendWhatsAppButtons({
          ...helperParams,
          to: from,
          header: 'Booking Summary',
          body: `✨ *Review Your Holi Booking* ✨

👤 *Client:* ${session.data.name}
📅 *Date:* ${session.data.date}
🕒 *Time:* ${session.data.time}
💇‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}
💅 *Service:* ${session.data.chosenService || 'General Salon Session'}

📱 *Contact:* ${session.data.phone}

*Please choose your communication preference below:*`,
          footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
          buttons: [
            { id: 'consent_confirm_all', title: '✅ Accept All' },
            { id: 'consent_reminders_only', title: '📅 Reminders Only' },
            { id: 'consent_none', title: '❌ No Thanks' }
          ]
        });
        session.step = 'appt_consent';
        res.status(200).end();
        return;
      }
    } else {
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: `Please type your full name to continue.`
      });
      session.step = 'appt_name';
      res.status(200).end();
      return;
    }
  }

  // Appointment: Confirm with previous consent
  if (session.step === 'appt_confirm_with_previous_consent') {
    if (userMsg === 'confirm_with_previous_consent') {
      // User confirmed with previous consent - proceed to booking
      console.log('✅ User confirmed appointment with previous consent');

      // Check if appointment is already being processed to prevent duplicates
      if (session.data.isProcessing) {
        console.log('Appointment already being processed for user:', from);
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Your appointment is being processed. Please wait...'
        });
        res.status(200).end();
        return;
      }

      // Set processing flag to prevent duplicate bookings
      session.data.isProcessing = true;

      // Proceed with booking using the stored consent
      // (session.data.consent is already set from previous step)

      // Create Google Calendar event
      let eventId = '';
      try {
        // Use the selected slot data for accurate booking
        const selectedSlot = session.data.selectedSlot;
        if (!selectedSlot || !selectedSlot.slot) {
          throw new Error('No slot data available');
        }
        // Get start and end times from the selected slot (already in IST)
        const slotStart = selectedSlot.slot.start;
        const slotEnd = selectedSlot.slot.end;
        // Convert to UTC ISO for Google Calendar API
        const startISO = slotStart.toUTC().toISO();
        const endISO = slotEnd.toUTC().toISO();
        console.log('Creating Google Calendar event with:', {
          dateStr: session.data.date,
          timeStr: session.data.time,
          slotStart: slotStart.toISO(),
          slotEnd: slotEnd.toISO(),
          startISO,
          endISO
        });
        const stylistId = session.data.stylistId || session.data.stylist;
        const calendarId = calendars[stylistId] || calendars[session.data.stylist] || process.env.GCAL_CALENDAR_ID;

        // Check if an event already exists for this time slot to prevent duplicates
        try {
          const existingEvents = await getAvailableTimeSlots({
            date: session.data.date,
            startTime: '00:00',
            endTime: '23:59',
            calendarId
          });

          // Check if there's already an event in this time slot
          const conflictingEvent = existingEvents.find(event => {
            const eventStart = DateTime.fromISO(event.start);
            const eventEnd = DateTime.fromISO(event.end);
            const slotStartTime = slotStart;
            const slotEndTime = slotEnd;

            // Check if events overlap
            return (slotStartTime < eventEnd && slotEndTime > eventStart);
          });

          if (conflictingEvent) {
            console.log('⚠️ Conflicting event found:', conflictingEvent);
            throw new Error('This time slot is no longer available. Please choose a different time.');
          }
        } catch (checkError) {
          console.log('⚠️ Could not check for conflicting events:', checkError.message);
          // Continue with booking even if check fails
        }

        // Create event description based on consent
        let eventDescription = `Name: ${session.data.name}\nPhone: ${session.data.phone}\nService: ${session.data.chosenService || ''}\nStylist: ${session.data.stylist || ''}\nDate: ${session.data.date}\nTime: ${session.data.time}\nBooked via WhatsApp`;

        // Add consent status to event description
        if (session.data.consent.appointmentReminders && session.data.consent.birthdayMessages) {
          eventDescription += '\n\n🔔 User has consented to receive appointment reminders and birthday messages.';
        } else if (session.data.consent.appointmentReminders) {
          eventDescription += '\n\n📅 User has consented to receive appointment reminders only.';
        } else {
          eventDescription += '\n\n❌ User has opted out of all communications.';
        }

        const event = await createEvent({
          summary: `Appointment: ${session.data.name} - ${session.data.chosenService || ''} with ${session.data.stylist || ''}`,
          footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
          description: eventDescription,
          start: startISO,
          end: endISO,
          attendees: [],
          calendarId
        });
        eventId = event.id;
      } catch (err) {
        console.error('Error creating Google Calendar event:', err);
        console.error('Session data:', {
          date: session.data.date,
          time: session.data.time,
          name: session.data.name,
          phone: session.data.phone,
          service: session.data.chosenService,
          stylist: session.data.stylist
        });
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Sorry, there was an error booking your appointment. Please try again or contact support.'
        });
        session.data.isProcessing = false;
        session.step = 'home';
        res.status(200).end();
        return;
      }

      // Save appointment to DB with consent data
      try {
        // Ensure all required fields are present
        const appointmentData = {
          name: session.data.name,
          email: '', // not collected in this flow
          phone: session.data.phone,
          service: session.data.chosenService || '',
          doctor: session.data.stylist || '', // Map stylist to doctor field
          date: session.data.date,
          time: session.data.time,
          eventId,
          consent: session.data.consent,
          clientId // Add clientId to link appointment to the correct business
        };

        // Validate required fields before saving
        if (!appointmentData.name || !appointmentData.phone || !appointmentData.doctor) {
          throw new Error(`Missing required fields: name=${appointmentData.name}, phone=${appointmentData.phone}, doctor=${appointmentData.doctor}`);
        }

        console.log('Saving appointment to database:', {
          name: appointmentData.name,
          phone: appointmentData.phone,
          service: appointmentData.service,
          doctor: appointmentData.doctor,
          date: appointmentData.date,
          time: appointmentData.time,
          consent: appointmentData.consent
        });

        const selectedServiceId = session.data.chosenService;
        const serviceInfo = salonServices.find(s => s.id === selectedServiceId);
        const serviceTitle = serviceInfo ? serviceInfo.title : selectedServiceId;

        const serviceDb = await ServiceModel.findOne({ clientId: appointmentData.clientId, name: serviceTitle });
        let revenue = serviceDb ? serviceDb.price : 0;

        if (revenue === 0) {
          const pricing = salonPricing.find(p => p.service === serviceTitle);
          if (pricing) {
            revenue = parseInt(pricing.price.replace(/[^\d]/g, ''));
          }
        }
        appointmentData.revenue = revenue;

        await Appointment.create(appointmentData);

        // Update AdLead with booking points
        try {
          await AdLead.updateOne(
            { clientId, phoneNumber: session.data.phone },
            {
              $inc: { appointmentsBooked: 1 },
              $set: {
                lastInteraction: new Date(),
                name: session.data.name // Ensure name is up to date
              }
            },
            { upsert: true }
          );
          console.log('✅ AdLead updated with booking points for:', session.data.phone);
        } catch (adErr) {
          console.error('❌ Error updating AdLead:', adErr);
        }


        try {
          const io = req.app.get('socketio');
          if (io) {
            io.to(`client_${clientId}`).emit('appointments_update', { type: 'created' });
          }
        } catch { }

        console.log('✅ Appointment saved successfully to database');

      } catch (dbError) {
        console.error('❌ Error saving appointment to database:', dbError);

        // Try to delete the Google Calendar event if database save failed
        if (eventId) {
          try {
            await deleteEvent(eventId, calendarId);
            console.log('✅ Deleted Google Calendar event due to database save failure');
          } catch (deleteError) {
            console.error('❌ Error deleting Google Calendar event:', deleteError);
          }
        }

        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Sorry, there was an error saving your appointment. Please try again or contact support.'
        });

        // Reset processing flag
        session.data.isProcessing = false;
        session.step = 'home';
        res.status(200).end();
        return;
      }

      // Update BirthdayUser collection based on consent
      if (session.data.consent.birthdayMessages) {
        await BirthdayUser.updateOne(
          { number: session.data.phone },
          {
            $set: {
              isOpted: true,
              month: new Date().getMonth() + 1, // Current month as default
              day: new Date().getDate() // Current day as default
            },
            $unset: { optedOutOn: 1 }
          },
          { upsert: true }
        );
      } else {
        await BirthdayUser.updateOne(
          { number: session.data.phone },
          {
            $set: {
              isOpted: false,
              optedOutOn: new Date().toISOString()
            }
          },
          { upsert: true }
        );
      }

      // Notify admins of new booking with detailed consent status
      let consentStatus = '';
      if (session.data.consent.appointmentReminders && session.data.consent.birthdayMessages) {
        consentStatus = '✅ Consented to appointment reminders and birthday messages (reused from previous)';
      } else if (session.data.consent.appointmentReminders) {
        consentStatus = '📅 Consented to appointment reminders only (reused from previous)';
      } else {
        consentStatus = '❌ Opted out of all communications (reused from previous)';
      }

      const adminMsg = `🚨 *New Appointment Booked*\n\n` +
        `👤 *User Name:* ${session.data.name}\n` +
        `📱 *User Phone:* ${session.data.phone}\n` +
        `💇‍♀️ *Service:* ${session.data.chosenService || 'General Session'}\n` +
        `🎨 *Stylist:* ${session.data.stylist || 'Any'}\n` +
        `📅 *Date:* ${session.data.date}\n` +
        `🕒 *Time:* ${session.data.time}\n\n` +
        `📋 *Status:* ${consentStatus}`;
      await notifyAdmins({ ...helperParams, message: adminMsg, adminNumbers });

      // Send confirmation to user based on consent
      let confirmationBody = `✅ *Booking Confirmed*\n\n` +
        `📅 *Date:* ${session.data.date}\n` +
        `🕒 *Time:* ${session.data.time}\n` +
        `💇‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n\n` +
        `📍 *Location:* Choice Salon for Ladies, Nikol\n` +
        `🏢 *Address:* 2nd Floor, Raspan Arcade, 6-7, Raspan Cross Rd, Nikol, Ahmedabad\n` +
        `🗺️ *Map:* https://maps.google.com/?q=Choice+Salon+Raspan+Arcade+Nikol\n\n` +
        `⏰ *Please arrive 15 minutes early* for your appointment.`;

      // Add consent-specific confirmation message
      if (session.data.consent.appointmentReminders && session.data.consent.birthdayMessages) {
        confirmationBody += `\n\n🔔 *Reminders:* You'll receive updates before your appointment.`;
      } else if (session.data.consent.appointmentReminders) {
        confirmationBody += `\n\n📅 *Reminders:* You'll receive updates before your appointment.`;
      }

      confirmationBody += `\n\n,
          footer: '❌ To stop receiving messages, reply with "STOP" at any time.'`;

      await sendWhatsAppButtons({
        ...helperParams,
        to: from,
        header: 'Got it 👍',
        body: confirmationBody,
        buttons: [
          { id: 'book_another', title: '📅 Book Another' },
          { id: 'user_ask_question', title: '❓ Ask Question' },
          { id: 'home', title: '🏠 Home' }
        ]
      });

      // Send Upsell message after 5 minutes (300,000 ms)
      setTimeout(async () => {
        try {
          let upsellMsg = '';
          const chosenService = (session.data.chosenService || '').toLowerCase();

          if (chosenService.includes('haircut')) {
            upsellMsg = `✨ *Exclusive Upgrade for You!* ✨\n\n` +
              `Since you've booked a Haircut, would you like to add a *Luxury Hair Spa* or a *Deep Conditioning Treatment*? 🛁\n\n` +
              `These treatments are perfect for keeping your hair healthy and shiny! ✨\n\n` +
              `🎁 *SPECIAL OFFER:* Get *10% OFF* if you add any treatment to your haircut today! 🎟️\n\n` +
              `Reply "YES" if you'd like to add this to your booking.`;
          } else {
            // General upsell for other services
            upsellMsg = `✨ *Complete Your Glow-Up!* ✨\n\n` +
              `Would you like to add a *Refreshing Pedicure* or *Threading* to your visit? 🦶🧶\n\n` +
              `🎁 *SPECIAL OFFER:* Book an additional service now and get *10% OFF* on the add-on! 🎟️\n\n` +
              `Reply with the service name if you're interested!`;
          }

          await sendWhatsAppText({
            ...helperParams,
            to: from,
            body: upsellMsg
          });
          console.log(`✅ Delayed upsell message sent to ${from}`);
        } catch (err) {
          console.error(`❌ Error sending delayed upsell message to ${from}:`, err);
        }
      }, 300000);

      // Reset processing flag and clear session data
      session.data.isProcessing = false;
      session.step = 'home';
      session.data = {}; // Clear all session data

      console.log('✅ Appointment booking completed successfully for user:', from);

      res.status(200).end();
      return;

    } else if (userMsg === 'change_consent_preferences') {
      // User wants to change preferences - show consent options
      await sendWhatsAppButtons({
        ...helperParams,
        to: from,
        header: '📋 Change Communication Preferences',
        body: `*Appointment Details:*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n�‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n💅 *Service:* ${session.data.chosenService || 'General Salon Session'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\nWe'd like to send you:\n• Appointment reminders\n• Birthday wishes\n\nPlease choose your preference:`,
        footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
        buttons: [
          { id: 'consent_confirm_all', title: '✅ Accept All' },
          { id: 'consent_reminders_only', title: '📅 Reminders Only' },
          { id: 'consent_none', title: '❌ No Thanks' }
        ]
      });
      session.step = 'appt_consent';
      res.status(200).end();
      return;
    } else {
      // Invalid input - show confirmation again
      await sendWhatsAppButtons({
        ...helperParams,
        to: from,
        header: '📋 Confirm Appointment',
        body: `Please confirm your appointment or change your communication preferences.`,
        footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
        buttons: [
          { id: 'confirm_with_previous_consent', title: '✅ Confirm Appointment' },
          { id: 'change_consent_preferences', title: '🔄 Change Preferences' }
        ]
      });
      session.step = 'appt_confirm_with_previous_consent';
      res.status(200).end();
      return;
    }
  }

  // Appointment: Consent step
  if (session.step === 'appt_consent') {
    if (userMsg === 'consent_confirm_all' || userMsg === 'consent_reminders_only' || userMsg === 'consent_none') {

      // Check if appointment is already being processed to prevent duplicates
      if (session.data.isProcessing) {
        console.log('Appointment already being processed for user:', from);
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Your appointment is being processed. Please wait...'
        });
        res.status(200).end();
        return;
      }

      // Set processing flag to prevent duplicate bookings
      session.data.isProcessing = true;

      // Store consent preference based on user selection
      let consentOptions = {
        appointmentReminders: false,
        birthdayMessages: false,
        marketingMessages: false
      };

      // Set consent based on user selection
      if (userMsg === 'consent_confirm_all') {
        consentOptions = {
          appointmentReminders: true,
          birthdayMessages: true,
          marketingMessages: false // No marketing messages
        };
      } else if (userMsg === 'consent_reminders_only') {
        consentOptions = {
          appointmentReminders: true,
          birthdayMessages: false,
          marketingMessages: false
        };
      }
      // For 'consent_none', all options remain false

      session.data.consent = {
        ...consentOptions,
        consentedAt: new Date()
      };

      // Create Google Calendar event
      let eventId = '';
      try {
        // Use the selected slot data for accurate booking
        const selectedSlot = session.data.selectedSlot;
        if (!selectedSlot || !selectedSlot.slot) {
          throw new Error('No slot data available');
        }
        // Get start and end times from the selected slot (already in IST)
        const slotStart = selectedSlot.slot.start;
        const slotEnd = selectedSlot.slot.end;
        // Convert to UTC ISO for Google Calendar API
        const startISO = slotStart.toUTC().toISO();
        const endISO = slotEnd.toUTC().toISO();
        console.log('Creating Google Calendar event with:', {
          dateStr: session.data.date,
          timeStr: session.data.time,
          slotStart: slotStart.toISO(),
          slotEnd: slotEnd.toISO(),
          startISO,
          endISO
        });
        const stylistId = session.data.stylistId || session.data.stylist;
        const calendarId = calendars[stylistId] || calendars[session.data.stylist] || process.env.GCAL_CALENDAR_ID;

        // Check if an event already exists for this time slot to prevent duplicates
        try {
          const existingEvents = await getAvailableTimeSlots({
            date: session.data.date,
            startTime: '00:00',
            endTime: '23:59',
            calendarId
          });

          // Check if there's already an event in this time slot
          const conflictingEvent = existingEvents.find(event => {
            const eventStart = DateTime.fromISO(event.start);
            const eventEnd = DateTime.fromISO(event.end);
            const slotStartTime = slotStart;
            const slotEndTime = slotEnd;

            // Check if events overlap
            return (slotStartTime < eventEnd && slotEndTime > eventStart);
          });

          if (conflictingEvent) {
            console.log('⚠️ Conflicting event found:', conflictingEvent);
            throw new Error('This time slot is no longer available. Please choose a different time.');
          }
        } catch (checkError) {
          console.log('⚠️ Could not check for conflicting events:', checkError.message);
          // Continue with booking even if check fails
        }

        // Create event description based on consent
        let eventDescription = `Name: ${session.data.name}\nPhone: ${session.data.phone}\nService: ${session.data.chosenService || ''}\nStylist: ${session.data.stylist || ''}\nDate: ${session.data.date}\nTime: ${session.data.time}\nBooked via WhatsApp`;

        // Add consent status to event description
        if (session.data.consent.appointmentReminders && session.data.consent.birthdayMessages) {
          eventDescription += '\n\n🔔 User has consented to receive appointment reminders and birthday messages.';
        } else if (session.data.consent.appointmentReminders) {
          eventDescription += '\n\n📅 User has consented to receive appointment reminders only.';
        } else {
          eventDescription += '\n\n❌ User has opted out of all communications.';
        }

        const event = await createEvent({
          summary: `Appointment: ${session.data.name} - ${session.data.chosenService || ''} with ${session.data.stylist || ''}`,
          description: eventDescription,
          start: startISO,
          end: endISO,
          attendees: [],
          calendarId
        });
        eventId = event.id;
      } catch (err) {
        console.error('Error creating Google Calendar event:', err);
        console.error('Session data:', {
          date: session.data.date,
          time: session.data.time,
          name: session.data.name,
          phone: session.data.phone,
          service: session.data.chosenService,
          stylist: session.data.stylist
        });
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Sorry, there was an error booking your appointment. Please try again or contact support.'
        });
        session.step = 'home';
        res.status(200).end();
        return;
      }

      // Save appointment to DB with consent data
      try {
        // Ensure all required fields are present
        const appointmentData = {
          name: session.data.name,
          email: '', // not collected in this flow
          phone: session.data.phone,
          service: session.data.chosenService || '',
          doctor: session.data.stylist || '', // Map stylist to doctor field
          date: session.data.date,
          time: session.data.time,
          eventId,
          consent: session.data.consent,
          clientId // Add clientId to link appointment to the correct business
        };

        // Validate required fields before saving
        if (!appointmentData.name || !appointmentData.phone || !appointmentData.doctor) {
          throw new Error(`Missing required fields: name=${appointmentData.name}, phone=${appointmentData.phone}, doctor=${appointmentData.doctor}`);
        }

        console.log('Saving appointment to database:', {
          name: appointmentData.name,
          phone: appointmentData.phone,
          service: appointmentData.service,
          doctor: appointmentData.doctor,
          date: appointmentData.date,
          time: appointmentData.time,
          consent: appointmentData.consent
        });

        const selectedServiceId = session.data.chosenService;
        const serviceInfo = salonServices.find(s => s.id === selectedServiceId);
        const serviceTitle = serviceInfo ? serviceInfo.title : selectedServiceId;

        const serviceDb = await ServiceModel.findOne({ clientId: appointmentData.clientId, name: serviceTitle });
        let revenue = serviceDb ? serviceDb.price : 0;

        if (revenue === 0) {
          const pricing = salonPricing.find(p => p.service === serviceTitle);
          if (pricing) {
            revenue = parseInt(pricing.price.replace(/[^\d]/g, ''));
          }
        }
        appointmentData.revenue = revenue;

        await Appointment.create(appointmentData);

        try {
          const io = req.app.get('socketio');
          if (io) {
            io.to(`client_${clientId}`).emit('appointments_update', { type: 'created' });
          }
        } catch { }

        console.log('✅ Appointment saved successfully to database');

      } catch (dbError) {
        console.error('❌ Error saving appointment to database:', dbError);

        // Try to delete the Google Calendar event if database save failed
        if (eventId) {
          try {
            await deleteEvent(eventId, calendarId);
            console.log('✅ Deleted Google Calendar event due to database save failure');
          } catch (deleteError) {
            console.error('❌ Error deleting Google Calendar event:', deleteError);
          }
        }

        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Sorry, there was an error saving your appointment. Please try again or contact support.'
        });

        // Reset processing flag
        session.data.isProcessing = false;
        session.step = 'home';
        res.status(200).end();
        return;
      }

      // Update BirthdayUser collection based on consent
      if (session.data.consent.birthdayMessages) {
        await BirthdayUser.updateOne(
          { number: session.data.phone },
          {
            $set: {
              isOpted: true,
              month: new Date().getMonth() + 1, // Current month as default
              day: new Date().getDate() // Current day as default
            },
            $unset: { optedOutOn: 1 }
          },
          { upsert: true }
        );
      } else {
        await BirthdayUser.updateOne(
          { number: session.data.phone },
          {
            $set: {
              isOpted: false,
              optedOutOn: new Date().toISOString()
            }
          },
          { upsert: true }
        );
      }

      // Notify admins of new booking with detailed consent status
      let consentStatus = '';
      if (session.data.consent.appointmentReminders && session.data.consent.birthdayMessages) {
        consentStatus = 'Consented to appointment reminders and birthday messages';
      } else if (session.data.consent.appointmentReminders) {
        consentStatus = 'Consented to appointment reminders only';
      } else {
        consentStatus = 'Opted out of all communications';
      }

      const adminMsg = `New Appointment Booked\n\n` +
        `User Name: ${session.data.name}\n` +
        `User Phone: ${session.data.phone}\n` +
        `Service: ${session.data.chosenService || 'General Session'}\n` +
        `Stylist: ${session.data.stylist || 'Any'}\n` +
        `Date: ${session.data.date}\n` +
        `Time: ${session.data.time}\n\n` +
        `Status: ${consentStatus}`;
      await notifyAdmins({ ...helperParams, message: adminMsg, adminNumbers });

      // Send confirmation to user based on consent
      let confirmationBody = `Appointment Confirmed\n\n` +
        `Date: ${session.data.date}\n` +
        `Time: ${session.data.time}\n` +
        `Stylist: ${session.data.stylist || 'Not specified'}\n\n` +
        `Location: Choice Salon for Ladies, Nikol\n` +
        `Address: 2nd Floor, Raspan Arcade, 6-7, Raspan Cross Rd, Nikol, Ahmedabad\n` +
        `Map: https://maps.google.com/?q=Choice+Salon+Raspan+Arcade+Nikol\n\n` +
        `Please arrive 15 minutes early for your appointment.`;

      confirmationBody += `\n\nReminders: You'll receive updates before your appointment.`;

      await sendWhatsAppButtons({
        ...helperParams,
        to: from,
        header: '✅ Booking Confirmed',
        body: confirmationBody,
        footer: '❌ To stop receiving messages, reply with "STOP" at any time.',
        buttons: [
          { id: 'book_another', title: '📅 Book Another' },
          { id: 'user_ask_question', title: '❓ Ask Question' },
          { id: 'user_home', title: '🏠 Home' }
        ]
      });

      // Send Upsell message after 5 minutes (300,000 ms)
      setTimeout(async () => {
        try {
          let upsellMsg = '';
          const chosenService = (session.data.chosenService || '').toLowerCase();

          if (chosenService.includes('haircut')) {
            upsellMsg = `Exclusive Upgrade for You\n\n` +
              `Since you've booked a Haircut, would you like to add a Luxury Hair Spa or a Deep Conditioning Treatment?\n\n` +
              `These treatments help keep your hair healthy and shiny.\n\n` +
              `SPECIAL OFFER: Get 10% OFF if you add any treatment to your haircut today.\n\n` +
              `Reply "YES" if you'd like to add this to your booking.`;
          } else {
            // General upsell for other services
            upsellMsg = `Complete Your Visit\n\n` +
              `Would you like to add a Refreshing Pedicure or Threading to your visit?\n\n` +
              `SPECIAL OFFER: Book an additional service now and get 10% OFF on the add-on.\n\n` +
              `Reply with the service name if you're interested!`;
          }

          await sendWhatsAppText({
            ...helperParams,
            to: from,
            body: upsellMsg
          });
          console.log(`✅ Delayed upsell message sent to ${from}`);
        } catch (err) {
          console.error(`❌ Error sending delayed upsell message to ${from}:`, err);
        }
      }, 300000);

      // Reset processing flag and clear session data
      session.data.isProcessing = false;
      session.step = 'home';
      session.data = {}; // Clear all session data

      console.log('✅ Appointment booking completed successfully for user:', from);

      res.status(200).end();
      return;
    } else {
      await sendWhatsAppButtons({
        ...helperParams,
        to: from,
        header: 'Appointment Summary',
        body: `Appointment Details:\n\nName: ${session.data.name}\nDate: ${session.data.date}\nTime: ${session.data.time}\nStylist: ${session.data.stylist || 'Not specified'}\nService: ${session.data.chosenService || 'General Salon Session'}\n\nPhone: ${session.data.phone}\n\nCommunication Preferences:\nWe can send you:\n• Appointment reminders\n• Birthday wishes\n\nPlease choose your preference:`,
        footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
        buttons: [
          { id: 'consent_confirm_all', title: '✅ Accept All' },
          { id: 'consent_reminders_only', title: '📅 Reminders Only' },
          { id: 'consent_none', title: '❌ No Thanks' }
        ]
      });
      session.step = 'appt_consent';
      res.status(200).end();
      return;
    }
  }



  // FAQ menu (now using list reply)
  if (session.step === 'faq_menu') {
    if ([
      'faq_hours',
      'faq_payment',
      'faq_services',
      'faq_human',
      'faq_home'
    ].includes(userMsg)) {
      // Respond to each FAQ option with a valid button set (max 3)
      if (userMsg === 'faq_hours') {
        await sendSmartButtonsOrList({
          ...helperParams,
          to: from,
          header: 'Hours',
          body: 'We\'re here Monday through Saturday from 10:00 AM to 6:00 PM. We\'re closed on Sundays.\n\nIs there anything else I can help you with today?',
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Turf' },
            { id: 'user_ask_question', title: 'Ask Question' },
            { id: 'user_home', title: 'Back to Menu' }
          ]
        });
      } else if (userMsg === 'faq_payment') {
        await sendSmartButtonsOrList({
          ...helperParams,
          to: from,
          header: 'Payment Options',
          body: 'We make it easy to pay! We accept all major credit and debit cards, cash payments, and UPI transfers. We also work with select insurance providers to help cover your treatment costs.\n\nReady to schedule your appointment?',
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Turf' },
            { id: 'user_ask_question', title: 'Ask Question' },
            { id: 'user_home', title: 'Back to Menu' }
          ]
        });
      } else if (userMsg === 'faq_services') {
        await sendSmartButtonsOrList({
          ...helperParams,
          to: from,
          header: 'Our Services',
          body: 'We offer comprehensive turf services including field bookings, coaching sessions, equipment rentals, tournaments, and much more! Our experienced team is here to take care of all your turf needs.\n\nWould you like to know more about a specific service or book a turf session?',
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Turf' },
            { id: 'user_ask_question', title: 'Ask Question' },
            { id: 'user_home', title: 'Back to Menu' }
          ]
        });
      } else if (userMsg === 'faq_human') {
        await sendSmartButtonsOrList({
          ...helperParams,
          to: from,
          header: 'Talk to Our Team',
          body: 'I’ve noted your request.\nOne of our team members will reach out to you shortly.\n\nIn the meantime, you can:',
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Turf' },
            { id: 'user_ask_question', title: 'Ask Question' },
            { id: 'user_home', title: 'Back to Menu' }
          ]
        });
      } else if (userMsg === 'faq_home') {
        session.step = 'home';
        await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
        return;
      }
      session.step = 'faq_menu';
      res.status(200).end();
      return;
    } else {
      // Fallback for unexpected input in FAQ (use list again)
      await sendSmartButtonsOrList({
        ...helperParams,
        to: from,
        header: 'I didn’t catch that',
        body: 'Please use the options below so I can guide you better:',
        buttons: [
          { id: 'faq_hours', title: 'Turf Hours' },
          { id: 'faq_payment', title: 'Payment & Insurance' },
          { id: 'faq_services', title: 'Services We Offer' },
          { id: 'faq_human', title: 'Talk to Our Team' },
          { id: 'faq_home', title: 'Back to Start' }
        ]
      });
      session.step = 'faq_menu';
      res.status(200).end();
      return;
    }
  }

  // === BEGIN: Cancel/Reschedule Flows (improved) ===
  if (session.step === 'cancel_lookup' || session.step === 'reschedule_lookup') {
    // Use WhatsApp 'from' field as the phone number
    if (!session.data.cancelReschedulePhoneValue) {
      const phoneNumber = from;
      session.data.cancelReschedulePhoneValue = phoneNumber;
      try {
        // Search both calendars for appointments with this phone number
        const allAppointments = [];
        const today = new Date();
        const startDate = today.toISOString().slice(0, 10);
        const endDate = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        // Search all stylists' calendars
        for (const stylist of salonStylists) {
          const calendarId = stylistCalendars[stylist.title];
          if (calendarId) {
            try {
              const appointments = await findEventsByPhoneNumber({
                phone: phoneNumber,
                startDate,
                endDate,
                calendarId
              });
              appointments.forEach(apt => {
                apt.calendarId = calendarId;
                apt.stylist = stylist.title;
                apt.doctor = stylist.title; // For compatibility
              });
              allAppointments.push(...appointments);
            } catch (err) {
              console.error(`Error searching calendar for ${stylist.title}:`, err);
            }
          }
        }
        if (allAppointments.length === 1) {
          // Only one appointment found, proceed to confirmation
          const foundAppt = allAppointments[0];
          session.data.cancelEventId = foundAppt.eventId;
          session.data.cancelEventSummary = foundAppt.summary;
          session.data.cancelEventDate = foundAppt.date;
          session.data.cancelEventTime = foundAppt.time;
          session.data.cancelCalendarId = foundAppt.calendarId;
          session.data.cancelStylist = foundAppt.stylist;
          await sendWhatsAppButtons({
            ...helperParams,
            to: from,
            header: 'Confirm Action',
            body: `Found your booking:\n${foundAppt.summary}\nDate: ${foundAppt.date}\nTime: ${foundAppt.time}\nDo you want to ${session.step === 'cancel_lookup' ? 'cancel' : 'reschedule'} this appointment?`,
            footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
            buttons: [
              { id: 'confirm_yes', title: 'Yes, Confirm' },
              { id: 'confirm_no', title: 'No, Cancel' }
            ]
          });
          session.step = session.step === 'cancel_lookup' ? 'cancel_confirm' : 'reschedule_confirm';
          res.status(200).end();
          return;
        } else if (allAppointments.length > 1) {
          // Multiple appointments found, let user pick
          session.data.cancelEventChoices = allAppointments.map((a, idx) => ({
            eventId: a.eventId,
            summary: a.summary,
            date: a.date,
            time: a.time,
            calendarId: a.calendarId,
            stylist: a.stylist
          }));
          let msg = 'We found multiple bookings for your number. *Please reply with the number to select:*\n\n';
          session.data.cancelEventChoices.forEach((ev, idx) => {
            msg += `${idx + 1}️⃣ ${ev.summary} with ${ev.stylist}\n    📅 ${ev.date}   ⏰ ${ev.time}\n\n`;
          });
          await sendWhatsAppText({
            ...helperParams,
            to: from,
            body: msg
          });
          session.step = session.step === 'cancel_lookup' ? 'cancel_pick_event' : 'reschedule_pick_event';
          res.status(200).end();
          return;
        } else {
          await sendWhatsAppText({
            ...helperParams,
            to: from,
            body: 'No booking found for your WhatsApp number. Please check and try again.'
          });
          session.step = 'home';
          res.status(200).end();
          return;
        }
      } catch (err) {
        console.error('Error searching booking:', err);
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Sorry, there was an error searching for your booking. Please try again later.'
        });
        session.step = 'home';
        res.status(200).end();
        return;
      }
    }
  }
  if (session.step === 'cancel_pick_event' || session.step === 'reschedule_pick_event') {
    // User should reply with a number
    const idx = parseInt(userMsg, 10) - 1;
    const choices = session.data.cancelEventChoices || [];
    if (!isNaN(idx) && choices[idx]) {
      const foundEvent = choices[idx];
      session.data.cancelEventId = foundEvent.eventId;
      session.data.cancelEventSummary = foundEvent.summary;
      session.data.cancelEventDate = foundEvent.date;
      session.data.cancelEventTime = foundEvent.time;
      session.data.cancelCalendarId = foundEvent.calendarId;
      session.data.cancelStylist = foundEvent.stylist;
      await sendWhatsAppButtons({
        ...helperParams,
        to: from,
        header: 'Confirm Action',
        body: `You selected:\n${foundEvent.summary}\nDate: ${foundEvent.date}\nTime: ${foundEvent.time}\nStylist: ${foundEvent.stylist}\nDo you want to ${session.step === 'cancel_pick_event' ? 'cancel' : 'reschedule'} this appointment?`,
        footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
        buttons: [
          { id: 'confirm_yes', title: 'Yes, Confirm' },
          { id: 'confirm_no', title: 'No, Cancel' }
        ]
      });
      session.step = session.step === 'cancel_pick_event' ? 'cancel_confirm' : 'reschedule_confirm';
      res.status(200).end();
      return;
    } else {
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: 'Invalid selection. Please reply with the number of the booking you want to select.'
      });
      res.status(200).end();
      return;
    }
  }
  if (session.step === 'cancel_confirm') {
    if (userMsg === 'confirm_yes') {
      try {
        // Delete from Google Calendar using the correct calendar ID
        await deleteEvent(session.data.cancelEventId, session.data.cancelCalendarId);
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Your booking has been cancelled. The slot is now free and available for others to book.'
        });
        try {
          await Appointment.findOneAndDelete({ eventId: session.data.cancelEventId, clientId });
          const io = req.app.get('socketio');
          if (io) {
            io.to(`client_${clientId}`).emit('appointments_update', { type: 'deleted', eventId: session.data.cancelEventId });
          }
        } catch (err) {
          console.error('Error deleting appointment from DB:', err.message);
        }
      } catch (err) {
        console.error('Error cancelling booking:', err);
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'There was an error cancelling your booking. Please try again or contact support.'
        });
      }
      // Reset session data
      session.data.cancelEventId = undefined;
      session.data.cancelEventSummary = undefined;
      session.data.cancelEventDate = undefined;
      session.data.cancelEventTime = undefined;
      session.data.cancelEventChoices = undefined;
      session.data.cancelCalendarId = undefined;
      session.data.cancelDoctor = undefined;
      session.data.cancelReschedulePhone = undefined;
      session.data.cancelReschedulePhoneValue = undefined;
      session.step = 'home';
      res.status(200).end();
      return;
    } else if (userMsg === 'confirm_no') {
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: 'Cancellation aborted. Your appointment is still active.'
      });
      session.data.cancelEventId = undefined;
      session.data.cancelEventSummary = undefined;
      session.data.cancelEventDate = undefined;
      session.data.cancelEventTime = undefined;
      session.data.cancelEventChoices = undefined;
      session.data.cancelCalendarId = undefined;
      session.data.cancelDoctor = undefined;
      session.data.cancelReschedulePhone = undefined;
      session.data.cancelReschedulePhoneValue = undefined;
      session.step = 'home';
      res.status(200).end();
      return;
    } else {
      // Fallback for unexpected input
      await sendWhatsAppButtons({
        ...helperParams,
        to: from,
        header: 'Confirm Action',
        body: `Found your booking:\n${session.data.cancelEventSummary}\nDate: ${session.data.cancelEventDate}\nTime: ${session.data.cancelEventTime}\nDoctor: ${session.data.cancelDoctor}\nDo you want to cancel this booking?`,
        footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
        buttons: [
          { id: 'confirm_yes', title: 'Yes, Confirm' },
          { id: 'confirm_no', title: 'No, Cancel' }
        ]
      });
      res.status(200).end();
      return;
    }
  }
  if (session.step === 'reschedule_confirm') {
    if (userMsg === 'confirm_yes') {
      try {
        // Delete from Google Calendar using the correct calendar ID
        await deleteEvent(session.data.cancelEventId, session.data.cancelCalendarId);
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Your previous booking has been cancelled and the slot is now free for others.'
        });
        try {
          await Appointment.findOneAndDelete({ eventId: session.data.cancelEventId, clientId });
          const io = req.app.get('socketio');
          if (io) {
            io.to(`client_${clientId}`).emit('appointments_update', { type: 'deleted', eventId: session.data.cancelEventId });
          }
        } catch (err) {
          console.error('Error deleting appointment from DB (reschedule):', err.message);
        }
        // Reset session data for new booking, but keep phone for convenience
        const userPhone = session.data.cancelReschedulePhoneValue;
        session.data = { phone: userPhone };
        // Send the same initial message as "Book Appointment" flow
        const paginatedServices = getPaginatedServices(0);
        await sendWhatsAppList({
          ...helperParams,
          to: from,
          header: 'Book Turf ⚽',
          body: 'Which service do you need?',
          button: 'Select Service',
          rows: paginatedServices.services
        });
        session.step = 'choose_service';
        session.data.servicePage = 0;
        res.status(200).end();
        return;
      } catch (err) {
        console.error('Error rescheduling appointment:', err);
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'There was an error rescheduling your appointment. Please try again or contact support.'
        });
        session.step = 'home';
        res.status(200).end();
        return;
      }
    } else if (userMsg === 'confirm_no') {
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: 'Reschedule aborted. Your booking is still active.'
      });
      session.data.cancelEventId = undefined;
      session.data.cancelEventSummary = undefined;
      session.data.cancelEventDate = undefined;
      session.data.cancelEventTime = undefined;
      session.data.cancelEventChoices = undefined;
      session.data.cancelCalendarId = undefined;
      session.data.cancelDoctor = undefined;
      session.data.cancelReschedulePhone = undefined;
      session.data.cancelReschedulePhoneValue = undefined;
      session.step = 'home';
      res.status(200).end();
      return;
    } else {
      // Fallback for unexpected input
      await sendWhatsAppButtons({
        ...helperParams,
        to: from,
        header: 'Confirm Action',
        body: `Found your booking:\n${session.data.cancelEventSummary}\nDate: ${session.data.cancelEventDate}\nTime: ${session.data.cancelEventTime}\nDoctor: ${session.data.cancelDoctor}\nDo you want to reschedule this booking?`,
        footer: '🔔 Opt-in for reminders & birthday wishes 🎂',
        buttons: [
          { id: 'confirm_yes', title: 'Yes, Confirm' },
          { id: 'confirm_no', title: 'No, Cancel' }
        ]
      });
      res.status(200).end();
      return;
    }
  }
  // === END: Cancel/Reschedule Flows (improved) ===

  // FAQ/Ask a Question (AI-powered)
  if (session.step === 'faq_await') {

    // Check if user is trying to book an appointment via text
    if (userMsg && (userMsg.toLowerCase().includes('book') || userMsg.toLowerCase().includes('appointment') || userMsg.toLowerCase().includes('schedule') || userMsg.toLowerCase().includes('make appointment') || userMsg.toLowerCase().includes('book visit') || userMsg.toLowerCase().includes('see doctor'))) {
      // Start the booking flow directly
      const paginatedServices = getPaginatedServices(0);
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Book Turf ⚽',
        body: 'Perfect! I\'d be happy to help you book an turf. 😊 Which service do you need?',
        button: 'Select Service',
        rows: paginatedServices.services
      });
      session.step = 'choose_service';
      session.data.servicePage = 0;
      res.status(200).end();
      return;
    }

    // Enhanced OpenAI prompt for FAQ responses
    const prompt = `You are Ava, a friendly and knowledgeable assistant for TURF BOOKING in ahmedabad, Uganda. 

IMPORTANT INSTRUCTIONS:
1. Use the knowledge base below to provide accurate, helpful information
2. Be warm, conversational, and professional - like a real person
3. Use natural language with appropriate emojis
4. If asked about pricing, mention 4-5 top services only and suggest booking for specific treatments
5. If asked about booking, encourage them to type "book turf" or use the button
6. If asked about hours, always mention the specific working hours from the knowledge base
7. If the answer is not in the knowledge base, suggest calling the turf management or emailing
8. Always end responses with "Need anything else?" or similar friendly closing
9. For identity questions, use the specific response from the knowledge base

KNOWLEDGE BASE:
${knowledgeBase}

USER QUESTION: ${messages.text?.body || userMsg}

Please provide a helpful, human-like response:`;

    let aiResponse = '';
    try {
      aiResponse = await generateWithGemini(geminiKey, prompt);
      if (!aiResponse.toLowerCase().includes('need anything else') &&
        !aiResponse.toLowerCase().includes('anything else') &&
        !aiResponse.toLowerCase().includes('help you') &&
        !aiResponse.toLowerCase().includes('assistance')) {
        aiResponse += '\n\nNeed anything else I can help you with?';
      }
    } catch (err) {
      console.error('Gemini API error:', err);
      aiResponse = "I'm having trouble accessing information right now. Please try again, or use the buttons below.";
    }

    await sendSmartButtonsOrList({
      ...helperParams,
      to: from,
      header: undefined,
      body: aiResponse,
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Turf' },
        { id: 'user_home', title: 'Back to Menu' }
      ]
    });
    session.step = 'faq_await';
    res.status(200).end();
    return;
  }

  // Handle topic selection
  if (session.step === 'ask_question_topic') {
    const topic = QUESTION_TOPICS.find(t => t.id === userMsg);
    if (topic) {
      session.data.questionTopic = topic.title;
      if (topic.id === 'ask_other') {
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: 'Sure! 😊 What would you like to know? Feel free to ask me anything about our services, pricing, hours, or anything else!'
        });
        session.step = 'faq_await';
        res.status(200).end();
        return;
      } else {
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: `Great! I'd be happy to help you with ${topic.title} questions! 😊 What specific information are you looking for?`
        });
        session.step = 'faq_await';
        res.status(200).end();
        return;
      }
    }
  }

  // Fallback for any other unexpected input
  await sendSmartButtonsOrList({
    ...helperParams,
    to: from,
    header: 'Oops! I didn’t catch that 🙈',
    body: 'Please use the buttons below so I can guide you better:',
    buttons: [
      { id: 'user_schedule_appt', title: 'Booking' },
      { id: 'user_ask_question', title: 'Ask a Question' },
      { id: 'user_home', title: 'Start Over' }
    ]
  });
  session.step = 'home_waiting';
  res.status(200).end();
  return;
}



const handleWebhook = async (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  // console.log(JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry && req.body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;
    const phoneNumberId = value && value.metadata && value.metadata.phone_number_id;
    const messages = value && value.messages && value.messages[0];
    const from = messages && messages.from;

    // Only process if this is a real user message
    if (!messages || !from) {
      // Not a user message (could be a status update, etc)
      return res.status(200).end();
    }

    // --- DASHBOARD LOGIC START ---
    // Use dynamic client config if available, otherwise fallback to lookup or default
    let clientId = req.clientConfig ? req.clientConfig.clientId : 'code_clinic_v1';

    // Fallback lookup if no config (legacy support)
    if (!req.clientConfig && phoneNumberId) {
      try {
        const client = await Client.findOne({ phoneNumberId });
        if (client) clientId = client.clientId;
      } catch (e) { console.error('Client lookup failed:', e); }
    }

    const io = req.app.get('socketio');
    const token = req.clientConfig?.whatsappToken || process.env.WHATSAPP_TOKEN;

    const helperParams = { phoneNumberId, token, io, clientId };

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
      to: 'bot', // or phoneNumberId
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
      console.log('Socket emitted: new_message', savedMsg._id);
      io.to(`client_${clientId}`).emit('conversation_update', conversation);
      console.log('Socket emitted: conversation_update', conversation._id);
    }

    // 5. Check Takeover Status
    if (conversation.status === 'HUMAN_TAKEOVER') {
      console.log(`Conversation ${conversation._id} is in HUMAN_TAKEOVER mode. Bot paused.`);
      return res.status(200).end();
    }
    // --- DASHBOARD LOGIC END ---

    if (
      messages.type === 'button' &&
      messages.button &&
      messages.button.payload === 'Opt Out of Greetings'
    ) {
      console.log('🎂 Birthday opt-out button clicked by:', from);

      try {
        const result = await BirthdayUser.updateMany(
          { number: from, isOpted: true },
          {
            $set: {
              isOpted: false,
              optedOutOn: new Date().toISOString(),
            },
          }
        );

        if (result.modifiedCount > 0) {
          console.log(`✅ ${result.modifiedCount} record(s) updated for user ${from}`);

          await sendWhatsAppText({
            ...helperParams,
            to: from,
            body:
              'You have successfully opted out of birthday greetings. You will no longer receive birthday messages from us. If you change your mind, please contact our support team.',
          });
        } else {
          console.log(`❌ No active opted-in records found for user ${from}`);
        }
      } catch (err) {
        console.error('❌ Error handling birthday opt-out:', err);
      }

      return res.status(200).end();
    }

    // Admin leave management disabled for Choice Salon; route admins to user flow
    console.log('User logic (SALON BOOKING flow) triggered for', from);
    await handleUserChatbotFlow({ from, phoneNumberId, messages, res, clientConfig: req.clientConfig, io });
    return;
  } catch (err) {
    console.error('Error extracting data from webhook payload:', err);
  }
  res.status(200).end();
};

exports.handleWebhook = handleWebhook;
// Maintain router for backward compatibility
router.post('/', handleWebhook);

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

router.handleWebhook = handleWebhook;
module.exports = router;
