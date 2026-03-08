const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const { DoctorScheduleOverride } = require('../../models/DoctorScheduleOverride');
const fs = require('fs');
const crypto = require('crypto');
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
  'radhe radhe', 'halo', 'tame', 'subhashbhai'
];

const HOLI_DATES = 'Feb 24 - March 5';
const SERVER_URL = process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com';
const HOLI_IMG = `${SERVER_URL}/public/images/12.png`;

// Add at the top for topic list
const QUESTION_TOPICS = [
  { id: 'ask_services', title: 'Services' },
  { id: 'ask_pricing', title: 'Pricing' },
  { id: 'ask_appointments', title: 'Booking' },
  { id: 'ask_call_me', title: '📞 Talk to Admin' },
  { id: 'ask_other', title: 'Something else' }
];

const FAQ_DATA = {
  'ask_services': [
    { id: 'faq_serv_types', title: 'What services do you offer?', answer: 'We offer ladies haircuts, advanced hair spa, protein and straightening treatments, global color, highlights, and more. Come experience luxury and care! ✨' },
    { id: 'faq_serv_kids', title: 'Do you do kids haircuts?', answer: 'Yes. We provide haircuts for girls of all ages. Your little ones will love their fresh look! 👧' },
    { id: 'faq_serv_color', title: 'Do you do hair color?', answer: 'Yes. We offer professional global color and highlights to give your hair a stunning transformation. 🎨' },
    { id: 'faq_serv_spa', title: 'Do you offer hair spa?', answer: 'Yes. We have multiple premium hair spa options starting from just ₹999/-. Give your hair the ultimate nourishment! 🧖‍♀️' }
  ],
  'ask_pricing': [
    { id: 'faq_price_haircut', title: 'How much is a haircut?', answer: 'Our Haircut is ₹500 and Advance Haircut is ₹700. ✨' },
    { id: 'faq_price_list', title: `Pricing & Offers List`, answer: '✨ *Choice Salon Deals* ✨\n\nHair Spa\n• Normal Spa: ₹999\n• Loreal Spa: ₹1199\n• Silk Protein Spa: ₹1499\n• Shea Butter Spa: ₹1999\n• Permanent Spa: ₹1499\n\nHair Treatment\n• Mirror Shine Boto Smooth: ₹2999\n• Smoothing: ₹2799\n• Nano Therapy: ₹3299\n• Botox: ₹2499\n\nColour\n• Global Hair Color: ₹1999\n• Highlight Color: ₹1999\n\n*Prices depend on hair length & growth.*' },
    { id: 'faq_price_payment', title: 'Payment Methods', answer: 'We accept Cash, UPI, and all major Credit/Debit cards.' }
  ],
  'ask_appointments': [
    { id: 'faq_appt_book', title: 'How do I book?', answer: 'You can book an appointment directly here. Select "Book Appointment" from the main menu.' },
    { id: 'faq_appt_cancel', title: 'Cancel/Reschedule?', answer: 'To cancel or reschedule, please contact us directly at +91 98244 74547.' },
    { id: 'faq_appt_hours', title: 'Opening Hours?', answer: 'We are open Monday to Sunday, from 10:00 AM to 8:00 PM.' },
    { id: 'faq_appt_advance', title: 'Do I need to book ahead?', answer: 'We recommend booking at least 2 hours in advance to ensure your preferred stylist is available.' }
  ],
  'ask_other': [
    { id: 'faq_other_loc', title: 'Where are you located?', answer: 'We are at Second Floor, Raspan Arcade, 5-6, Raspan Cross Rd, opp. Gokul Party Plot, New India Colony, Nikol, Ahmedabad.' },
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
  try {
    // gemini-2.5-flash — gemini-2.0-flash is deprecated (404 for new users)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
    const resp = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
    const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text.trim();
  } catch (err) {
    console.error('Gemini API Error (choice_salon_holi):', err.message);
    return "Hi! 😊 Our AI system is currently updating its knowledge base. Please select from the menu options below or contact the salon directly!";
  }
}
const salonServices = [
  { id: 'svc_spa_normal', title: 'Normal Spa', price: '₹999/-', description: '₹1500 ❌ ➔ ₹999', category: 'Hair Spa 💅' },
  { id: 'svc_spa_loreal', title: 'Loreal Spa', price: '₹1,199/-', description: '₹1700 ❌ ➔ ₹1199', category: 'Hair Spa 💅' },
  { id: 'svc_spa_silk', title: 'Protein Spa', price: '₹1,499/-', description: '₹2000 ❌ ➔ ₹1499', category: 'Hair Spa 💅' },
  { id: 'svc_spa_shea', title: 'Shea Butter', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999', category: 'Hair Spa 💅' },
  { id: 'svc_spa_perm', title: 'Permanent Spa', price: '₹1,499/-', description: '₹2500 ❌ ➔ ₹1499', category: 'Hair Spa 💅' },
  { id: 'svc_treat_mirror', title: 'Boto Smooth', price: '₹2,999/-', description: '₹4500 ❌ ➔ ₹2999', category: 'Treatment 💎' },
  { id: 'svc_treat_smooth', title: 'Smoothing', price: '₹2,799/-', description: '₹3500 ❌ ➔ ₹2799', category: 'Treatment 💎' },
  { id: 'svc_treat_nano', title: 'Nano Therapy', price: '₹3,299/-', description: '₹4000 ❌ ➔ ₹3299', category: 'Treatment 💎' },
  { id: 'svc_treat_botox', title: 'Botox', price: '₹2,499/-', description: '₹3300 ❌ ➔ ₹2499', category: 'Treatment 💎' },
  { id: 'svc_treat_brazil', title: 'Brazil Therapy', price: '₹2,499/-', description: '₹3000 ❌ ➔ ₹2499', category: 'Treatment 💎' },
  { id: 'svc_treat_keratin', title: 'Keratin', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999', category: 'Treatment 💎' },
  { id: 'svc_color_global', title: 'Global Color', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999', category: 'Colour 🎨' },
  { id: 'svc_color_balayage', title: 'Balayage', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999', category: 'Colour 🎨' },
  { id: 'svc_color_classic', title: 'Highlight', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999', category: 'Colour 🎨' },
  { id: 'svc_color_roots', title: 'Root Touch Up', price: '₹1,000/-', description: 'Professional Touch Up', category: 'Standard' },
  { id: 'svc_haircut_basic', title: 'Basic Haircut', price: '₹500/-', description: 'Professional Cut', category: 'Standard' },
  { id: 'svc_haircut_advance', title: 'Advance Haircut', price: '₹700/-', description: 'Stylized Cut', category: 'Standard' }
];

// Real stylists (Female focused)
const salonStylists = [
  { id: 'stylist_subhashbhai', title: 'subhashbhai', description: 'Master Stylist (15+ yrs exp)' },
  { id: 'stylist_another', title: 'Another Staff', description: 'Senior Hair Specialist' }
];

// Map stylists to their specific Google Calendar IDs
const stylistCalendars = {
  'subhashbhai': process.env.GCAL_CALENDAR_ID2,
  'Another Staff': process.env.GCAL_CALENDAR_ID,
  'subhashbhai': process.env.GCAL_CALENDAR_ID2,
  'another_staff': process.env.GCAL_CALENDAR_ID,
  'stylist_subhashbhai': process.env.GCAL_CALENDAR_ID2,
  'stylist_another': process.env.GCAL_CALENDAR_ID
};

const salonPricing = [
  { category: `Special Offers 💅`, service: 'Normal Spa', price: '₹1500 ❌ ➔ ₹999' },
  { category: 'Special Offers 💅', service: 'Loreal Spa', price: '₹1700 ❌ ➔ ₹1199' },
  { category: 'Special Offers 💅', service: 'Protein Spa', price: '₹2000 ❌ ➔ ₹1499' },
  { category: 'Special Offers 💅', service: 'Shea Butter', price: '₹2500 ❌ ➔ ₹1999' },
  { category: 'Special Offers 💅', service: 'Permanent Spa * T&C apply, pricing depends on length', price: '₹2500 ❌ ➔ ₹1499' },
  { id: 'svc_treat_mirror', title: 'Botosmooth', price: '₹2,999/-', description: '₹4500 ❌ ➔ ₹2999', category: 'Treatment 💎' },
  { id: 'svc_treat_smooth', title: 'Smoothing', price: '₹2,799/-', description: '₹3500 ❌ ➔ ₹2799', category: 'Treatment 💎' },
  { id: 'svc_treat_nano', title: 'Nano Therapy', price: '₹3,299/-', description: '₹4000 ❌ ➔ ₹3299', category: 'Treatment 💎' },
  { id: 'svc_treat_botox', title: 'Botox', price: '₹2,499/-', description: '₹3300 ❌ ➔ ₹2499', category: 'Treatment 💎' },
  { id: 'svc_treat_brazil', title: 'Brazil Therapy', price: '₹2,499/-', description: '₹3000 ❌ ➔ ₹2499', category: 'Treatment 💎' },
  { id: 'svc_treat_keratin', title: 'Keratin', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999', category: 'Treatment 💎' },
  { id: 'svc_color_global', title: 'Global Color', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999', category: 'Colour 🎨' },
  { id: 'svc_color_balayage', title: 'Balayage', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999', category: 'Colour 🎨' },
  { id: 'svc_color_classic', title: 'Highlight', price: '₹1,999/-', description: '₹2500 ❌ ➔ ₹1999', category: 'Colour 🎨' },
  { id: 'svc_color_roots', title: 'Root Touch Up', price: '₹1,000/-', description: 'Professional Touch Up', category: 'Standard' },
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
  if (!header && !imageHeader) delete data.interactive.header;
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
      footer: footer ? { text: footer } : (true ? { text: 'Choice Salon Holi Offer 🫧' } : { text: 'Choice Salon for Ladies 💅' }),
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
  if (!header && !imageHeader) delete data.interactive.header;
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

async function sendWhatsAppFlow({ phoneNumberId, to, header, body, token, io, clientId }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: { type: 'text', text: header || 'Book Appointment 💇‍♀️' },
      body: { text: body || 'Secure your spot in seconds! Tap below to open our dynamic booking flow.' },
      footer: { text: 'Choice Salon for Ladies ✨' },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: 'choice_salon_flow',
          flow_id: '1244048577247022',
          flow_cta: 'Book Now',
          flow_action: 'navigate',
          flow_action_payload: {
            screen: 'HOLI_BOOKING_SCREEN'
          }
        }
      }
    }
  };
  try {
    await axios.post(url, data, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('Error sending WhatsApp Flow:', err.response?.data || err.message);
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
    businessStart.setHours(10, 0, 0, 0); // 10:00 AM
    const businessEnd = new Date(now);
    businessEnd.setHours(21, 0, 0, 0); // 9:00 PM
    let startOffset = 0;
    if (now < businessStart || now >= businessEnd) {
      startOffset = 1;
    }
    for (let i = startOffset; days.length < 7; i++) {
      const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
      days.push({ id: `calendar_day_${days.length}`, title: label });
    }
    return days;
  }
}

// Helper function to get paginated services
function getPaginatedServices(page = 0) {
  const servicesPerPage = 8; // Show 8 services + "Choose Another Service"
  const startIndex = page * servicesPerPage;
  const endIndex = startIndex + servicesPerPage;
  const pageServices = salonServices.slice(startIndex, endIndex);

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
  const { whatsappToken: token, geminiApiKey, config, clientId } = clientConfig;
  // Merge DB config calendars with local hardcoded/env calendars
  const calendars = { ...stylistCalendars, ...(config.calendars || {}) };
  const adminNumbers = config.adminPhones || (config.adminPhone ? [config.adminPhone] : []);
  // Use already-trimmed key resolved and validated by clientConfig middleware
  const geminiKey = geminiApiKey || process.env.GEMINI_API_KEY?.trim();
  console.log(`[CHOICE_SALON_HOLI] Gemini key source: ${geminiApiKey ? 'DB/Middleware' : 'Env Fallback'}, len=${geminiKey?.length || 0}`);
  if (!geminiKey) console.warn('[CHOICE_SALON_HOLI] ⚠️ No Gemini API key found! AI replies will fail.');

  const session = getUserSession(from);
  const userMsgType = messages.type;

  // Extract button ID/Title or text body
  let userMsg = userMsgType === 'interactive' ? (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id || messages.interactive?.button_reply?.title) : messages.text?.body;
  const buttonTitle = messages.interactive?.button_reply?.title;

  // Handle template button reply "Book Free Haircut", payload could be the text or an ID.
  if (
    (userMsgType === 'button' && messages.button?.text === 'Book Free Haircut') ||
    (userMsgType === 'interactive' && buttonTitle === 'Book Free Haircut') ||
    (typeof userMsg === 'string' && userMsg.toLowerCase() === 'book free haircut')
  ) {
    userMsg = 'user_schedule_appt';
    session.step = 'home_waiting'; // Force step forward so it bypasses the welcome greeting
  }

  // Pass common params to helpers
  const helperParams = { phoneNumberId, token, io, clientId };

  // ===================================================================
  // HANDLE NON-TEXT MEDIA MESSAGES (image, video, audio, sticker, document, location)
  // Forward to admin + tell user images/media not supported by bot
  // ===================================================================
  if (['image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts'].includes(userMsgType)) {
    const mediaTypeLabels = {
      image: '📷 Image', video: '🎥 Video', audio: '🎤 Voice Note',
      document: '📄 Document', sticker: '😃 Sticker', location: '📍 Location', contacts: '👤 Contact'
    };
    const mediaLabel = mediaTypeLabels[userMsgType] || userMsgType;

    // Build the admin WhatsApp chat link
    const primaryAdmin = adminNumbers[0] || config.adminPhone || '919824474547';
    const adminChatLink = `https://wa.me/${primaryAdmin}`;

    await sendWhatsAppButtons({
      ...helperParams,
      to: from,
      body: `Thanks for sharing that ${mediaLabel.toLowerCase()}! 📸\n\nOur bot can only process text messages right now, but we've forwarded your ${mediaLabel.toLowerCase()} to Subhashbhai.\n\nYou can also chat with him directly 👇`,
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Appt 📅' },
        { id: 'user_ask_question', title: 'Ask a Question ❓' }
      ]
    });
    // Also send the admin link as a separate text
    await sendWhatsAppText({
      ...helperParams, to: from,
      body: `📞 Chat with Subhashbhai directly:\n${adminChatLink}`
    });
    res.status(200).end();
    return;
  }

  // ===================================================================
  // META WHATSAPP FLOW NFM_REPLY HANDLER — STORE + CONFIRM STEP
  // ===================================================================
  if (userMsgType === 'interactive' && messages.interactive?.type === 'nfm_reply') {
    try {
      const responseJson = JSON.parse(messages.interactive.nfm_reply.response_json);
      const serviceId = responseJson.service;
      const date = responseJson.date;
      const timeId = responseJson.time;
      const customer_name = responseJson.customer_name;

      console.log('[Choice Salon] NFM Reply received:', { serviceId, date, timeId, customer_name });

      if (!serviceId || !date || !timeId || !customer_name) {
        await sendWhatsAppText({ ...helperParams, to: from, body: 'We received your booking but some details were missing. Please try again.' });
        res.status(200).end();
        return;
      }

      // --- Map Flow service ID → human-readable name ---
      const FLOW_SERVICE_MAP = {
        'spa_normal': '🎁 Normal Spa + FREE Cut (₹999)',
        'spa_loreal': '🎁 Loreal Spa + FREE Cut (₹1199)',
        'spa_silk': '🎁 Protein Spa + FREE Cut (₹1499)',
        'spa_shea': '🎁 Shea Butter + FREE Cut (₹1999)',
        'spa_perm': '🎁 Permanent Spa + FREE Cut (₹1499)',
        'treat_mirror': '🎁 Mirror Botosmooth + FREE Cut (₹2999)',
        'cut_basic': '✂️ Basic Haircut (₹499)',
        'cut_advance': '✂️ Advance Haircut (₹699)',
        'treat_keratin': '💎 Keratin (₹2499)',
        'treat_botox': '💎 Botox (₹2799)',
        'treat_brazil': '💎 Brazil Therapy (₹2999)',
        'treat_loreal': '💎 Loreal Straightening (₹3499)',
        'treat_nano': '💎 Nano Therapy (₹3499)',
        'color_root': '🎨 Root Touch Up (₹999)',
        'color_global': '🎨 Global Color (₹1999)',
        'color_highlight': '🎨 Classic Highlight (₹1999)',
        'color_balayage': '🎨 Balayage Highlight (₹2499)',
        // New flow IDs without underscores:
        'svc_spa_normal': '🎁 Normal Spa (₹999)',
        'svc_spa_loreal': '🎁 Loreal Spa (₹1199)',
        'svc_spa_silk': '🎁 Protein Spa (₹1499)',
        'svc_spa_shea': '🎁 Shea Butter (₹1999)',
        'svc_spa_perm': '🎁 Permanent Spa (₹1499)',
        'svc_treat_mirror': '💎 Mirror Botosmooth (₹2999)',
        'svc_haircut_basic': '✂️ Basic Haircut (₹499)',
        'svc_haircut_advance': '✂️ Advance Haircut (₹699)',
        'svc_treat_keratin': '💎 Keratin (₹2499)',
        'svc_treat_botox': '💎 Botox (₹2799)',
        'svc_treat_brazil': '💎 Brazil Therapy (₹2999)',
        'svc_treat_loreal_straight': '💎 Loreal Straightening (₹3499)',
        'svc_treat_nano': '💎 Nano Therapy (₹3499)',
        'svc_color_roots': '🎨 Root Touch Up (₹999)',
        'svc_color_global': '🎨 Global Color (₹1999)',
        'svc_color_classic': '🎨 Classic Highlight (₹1999)',
        'svc_color_balayage': '🎨 Balayage (₹2499)'
      };

      let serviceLabel = FLOW_SERVICE_MAP[serviceId] || serviceId;
      const foundService = salonServices.find(s => s.id === serviceId);
      if (foundService) {
        serviceLabel = `${foundService.title} (${foundService.price})`;
      }

      // --- Resolve time slot ID → human-readable time ---
      let timeLabel = timeId; // fallback
      // If ID looks like "slot_0_1" try to convert; otherwise the ID itself may be readable
      const slotResult = await fetchRealTimeSlots(date, 0, 'subhashbhai', calendars);
      const matchedSlot = slotResult.slots.find(s => s.id === timeId || s.title === timeId);
      if (matchedSlot) {
        timeLabel = matchedSlot.title; // e.g. "10:00 AM"
      } else {
        // Try to prettify raw IDs like "10:00_AM" → "10:00 AM"
        timeLabel = timeId.replace(/_/g, ' ');
      }

      // --- Check slot availability before showing confirmation ---
      const isAvailable = slotResult.slots.some(s => s.id === timeId || s.title === timeId);
      if (!isAvailable) {
        await sendWhatsAppFlow({ ...helperParams, to: from, body: `Sorry! That slot just got booked! Tap below to pick a new time ⬇️` });
        res.status(200).end();
        return;
      }

      // --- Format Date ---
      let formattedDate = date;
      try {
        formattedDate = require('luxon').DateTime.fromISO(date).toFormat('cccc, dd LLL yyyy');
      } catch (e) {
        console.error('Date parsing error', e);
      }

      // --- Fetch prior consent for footer ---
      let footerText = '🔔 Opt-in for reminders & birthday wishes 🎂';
      try {
        const previousAppointments = await Appointment.find({ phone: from }).sort({ createdAt: -1 }).limit(1);
        if (previousAppointments.length > 0) {
          const lastAppointment = previousAppointments[0];
          if (lastAppointment.consent && lastAppointment.consent.consentedAt) {
            if (lastAppointment.consent.appointmentReminders && lastAppointment.consent.birthdayMessages) {
              footerText = '⭐ Your previous preference: Accept All';
              session.data.consentReused = lastAppointment.consent;
            } else if (lastAppointment.consent.appointmentReminders) {
              footerText = '📅 Your previous preference: Reminders';
              session.data.consentReused = lastAppointment.consent;
            } else {
              footerText = '❌ Your previous preference: No Comms';
              session.data.consentReused = lastAppointment.consent;
            }
          }
        }
      } catch (err) {
        console.error('Error fetching previous consent for flow check:', err);
      }

      // --- Store pending booking in session ---
      session.data.pendingBooking = { serviceId, serviceLabel, date, timeId, timeLabel, customer_name };
      session.step = 'flow_confirm_pending';

      // --- Send confirmation buttons ---
      await sendWhatsAppButtons({
        ...helperParams, to: from,
        body: `Almost there! Let's quickly double-check your details: ✨\n\n` +
          `👤 *Name:* ${customer_name}\n` +
          `📅 *Date:* ${formattedDate}\n` +
          `🕒 *Time:* ${timeLabel}\n` +
          `💇‍♀️ *Stylist:* subhashbhai\n` +
          `💅 *Service:* ${serviceLabel}\n\n` +
          `📱 *Phone:* ${from}`,
        footer: footerText,
        buttons: [
          { id: 'confirm_booking_yes', title: '✅ Confirm' },
          { id: 'confirm_booking_no', title: '🔄 Change' }
        ]
      });

      res.status(200).end();
      return;
    } catch (e) {
      console.error('[Choice Salon] NFM Reply Error:', e);
      await sendWhatsAppFlow({ ...helperParams, to: from, body: 'Something went wrong. Tap below to try booking again.' });
      res.status(200).end();
      return;
    }
  }

  // ===================================================================
  // BOOKING CONFIRMATION HANDLER (after flow nfm_reply confirmation)
  // ===================================================================
  if (session.step === 'flow_confirm_pending' && userMsg === 'confirm_booking_yes') {
    const pending = session.data.pendingBooking;
    if (!pending) {
      await sendWhatsAppText({ ...helperParams, to: from, body: 'No pending booking found. Please start again.' });
      session.step = 'home';
      res.status(200).end();
      return;
    }
    const { serviceId, serviceLabel, date, timeId, timeLabel, customer_name } = pending;
    const calendarId = calendars['subhashbhai'] || process.env.GCAL_CALENDAR_ID;

    // Re-verify slot hasn't been taken while user was confirming
    const slotResult = await fetchRealTimeSlots(date, 0, 'subhashbhai', calendars);
    const isStillAvailable = slotResult.slots.some(s => s.id === timeId || s.title === timeId);
    const matchedSlot = slotResult.slots.find(s => s.id === timeId || s.title === timeId);

    if (!isStillAvailable) {
      await sendWhatsAppFlow({ ...helperParams, to: from, body: `Sorry! The ${timeLabel} slot on ${date} was just taken. Please pick a new time ⬇️` });
      session.step = 'home';
      session.data.pendingBooking = null;
      res.status(200).end();
      return;
    }

    // Create Google Calendar event
    let eventId = '';
    try {
      const slotStart = matchedSlot?.slot?.start;
      const slotEnd = matchedSlot?.slot?.end;
      const startISO = slotStart ? slotStart.toUTC().toISO() : `${date}T09:00:00Z`;
      const endISO = slotEnd ? slotEnd.toUTC().toISO() : `${date}T10:00:00Z`;

      const event = await createEvent({
        summary: `Appointment: ${customer_name} - ${serviceLabel}`,
        description: `Name: ${customer_name}\nPhone: ${from}\nService: ${serviceLabel}\nDate: ${date}\nTime: ${timeLabel}\nBooked via WhatsApp Flow`,
        start: startISO,
        end: endISO,
        attendees: [],
        calendarId
      });
      eventId = event.id;
      console.log('[Choice Salon] Calendar event created:', eventId);
    } catch (calErr) {
      console.error('[Choice Salon] Calendar error:', calErr);
      await sendWhatsAppText({ ...helperParams, to: from, body: 'Sorry, there was an error booking into the calendar. Please try again.' });
      session.step = 'home';
      res.status(200).end();
      return;
    }

    // Save appointment to MongoDB
    try {
      const serviceInfo = salonServices.find(s => s.id === serviceId || s.title.toLowerCase().includes(serviceId));
      const serviceTitle = serviceInfo ? serviceInfo.title : serviceLabel;
      const serviceDb = await ServiceModel.findOne({ clientId, name: serviceTitle });
      const revenue = serviceDb ? serviceDb.price : 0;

      await Appointment.create({
        name: customer_name,
        email: '',
        phone: from,
        service: serviceTitle || serviceLabel,
        doctor: 'subhashbhai',
        date,
        time: timeLabel,
        eventId,
        revenue,
        clientId,
        consent: { appointmentReminders: true, birthdayMessages: false, marketingMessages: false, consentedAt: new Date() }
      });

      await AdLead.updateOne(
        { clientId, phoneNumber: from },
        { $inc: { appointmentsBooked: 1 }, $set: { lastInteraction: new Date(), name: customer_name } },
        { upsert: true }
      );
      console.log('[Choice Salon] Appointment saved to DB');
    } catch (dbErr) {
      console.error('[Choice Salon] DB save error:', dbErr);
      if (eventId) { try { await deleteEvent(eventId, calendarId); } catch (e) { } }
      await sendWhatsAppText({ ...helperParams, to: from, body: 'Sorry, there was an error saving your appointment. Please contact us directly.' });
      session.step = 'home';
      res.status(200).end();
      return;
    }

    let formattedDate = date;
    try {
      formattedDate = require('luxon').DateTime.fromISO(date).toFormat('cccc, dd LLL yyyy');
    } catch (e) {
      console.error('Date parsing error', e);
    }

    // Notify admins
    const adminMsg = `🚨 *New Appointment Booked*\n\n` +
      `👤 *User Name:* ${customer_name}\n📱 *User Phone:* ${from}\n💇‍♀️ *Service:* ${serviceLabel}\n🎨 *Stylist:* subhashbhai\n📅 *Date:* ${formattedDate}\n🕒 *Time:* ${timeLabel}\n\n📋 *Status:* ✅ Consented to appointment reminders and birthday messages (Booked via Flow)`;
    await notifyAdmins({ ...helperParams, message: adminMsg, adminNumbers });

    // Send confirmation ticket
    const confirmationBody = `You're all set! 🎉 We have your appointment confirmed. Here are the details:\n\n` +
      `👤 *Name:* ${customer_name}\n` +
      `💇‍♀️ *Service:* ${serviceLabel}\n` +
      `📅 *Date:* ${date}\n` +
      `🕒 *Time:* ${timeLabel}\n\n` +
      `📍 *Choice Salon*\n2nd Floor, Raspan Arcade, Nikol, Ahmedabad\n` +
      `🗺️ https://maps.google.com/?q=Choice+Salon+Raspan+Arcade+Nikol\n\n` +
      `⏰ Please arrive 10-15 minutes early!\n\nCan't wait to see you! 💖`;

    await sendWhatsAppButtons({
      ...helperParams, to: from,
      imageHeader: HOLI_IMG,
      body: confirmationBody,
      buttons: [
        { id: 'user_schedule_appt', title: '📅 Book Another' },
        { id: 'user_ask_question', title: '❓ Ask Question' }
      ]
    });

    // Mirror Shine upsell after 5 minutes
    setTimeout(async () => {
      try {
        await sendWhatsAppButtons({
          ...helperParams, to: from,
          imageHeader: UPSELL_IMG,
          body: `Hey, one quick thing! 🤫 Since you're already coming in, I have 2 slots left today for our premium *Mirror Shine Boto Smooth* (₹2,999). It gives your hair that crazy glass-like finish. ✨ Want me to upgrade your appointment?`,
          footer: 'Limited availability! Tap below 👇',
          buttons: [{ id: 'upsell_add_mirror_shine', title: 'Add to Booking 💎' }]
        });
      } catch (upsellErr) { console.error('[Choice Salon] Upsell error:', upsellErr); }
    }, 300000);

    session.step = 'home';
    session.data.pendingBooking = null;
    res.status(200).end();
    return;
  }

  if (session.step === 'flow_confirm_pending' && userMsg === 'confirm_booking_no') {
    session.data.pendingBooking = null;
    session.step = 'home_waiting';
    await sendWhatsAppButtons({
      ...helperParams, to: from,
      body: 'No problem! Your booking has been cancelled. What would you like to do? 😊',
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Appt 📅' },
        { id: 'user_ask_question', title: 'Ask a Question ❓' }
      ]
    });
    res.status(200).end();
    return;
  }



  // If userMsg is empty/undefined (reaction, unknown type), just ack
  if (!userMsg && userMsgType !== 'interactive') {
    res.status(200).end();
    return;
  }  // -----------------------------------------------------------
  // GLOBAL COMMANDS (STOP, GREETINGS) - MUST BE CHECKED FIRST
  // -----------------------------------------------------------

  // Handle STOP/UNSUBSCRIBE commands
  if (userMsgType === 'text' && userMsg && (userMsg.trim().toLowerCase() === 'stop' || userMsg.trim().toLowerCase() === 'unsubscribe')) {
    try {
      await BirthdayUser.updateOne({ number: from }, { $set: { isOpted: false, optedOutOn: new Date().toISOString() } }, { upsert: true });
      await Appointment.updateMany({ phone: from }, { $set: { 'consent.appointmentReminders': false, 'consent.birthdayMessages': false, 'consent.marketingMessages': false, 'consent.consentedAt': new Date() } });
      await sendWhatsAppText({ ...helperParams, to: from, body: 'You have been successfully opted out. We will not send you any further marketing or reminder messages. Reply "RESUBSCRIBE" at any time to opt back in.' });
      delete userSessions[from];
      res.status(200).end();
      return;
    } catch (err) {
      console.error('Error processing opt-out request:', err);
      res.status(200).end();
      return;
    }
  }

  // Handle RESUBSCRIBE commands
  if (userMsgType === 'text' && userMsg && userMsg.trim().toLowerCase() === 'resubscribe') {
    try {
      await BirthdayUser.updateOne({ number: from }, { $set: { isOpted: true, optedOutOn: null } }, { upsert: true });
      await Appointment.updateMany({ phone: from }, { $set: { 'consent.appointmentReminders': true, 'consent.birthdayMessages': true, 'consent.marketingMessages': true, 'consent.consentedAt': new Date() } });
      await sendWhatsAppText({ ...helperParams, to: from, body: '✅ You have been successfully resubscribed to appointment reminders and birthday messages. Welcome back! 🎉' });
      delete userSessions[from];
      res.status(200).end();
      return;
    } catch (err) {
      console.error('Error processing subscribe request:', err);
      await sendWhatsAppText({ ...helperParams, to: from, body: '⚠️ We encountered an error processing your request.' });
      res.status(200).end();
      return;
    }
  }

  // If user sends a greeting, always globally reset and show the main menu with buttons
  const msgLower = (userMsgType === 'text' && userMsg) ? userMsg.trim().toLowerCase() : '';
  const isGreeting = msgLower && GREETING_WORDS.some(w =>
    msgLower === w || msgLower.startsWith(w + ' ') || msgLower.startsWith(w + ',') || msgLower.startsWith(w + '!') || msgLower.startsWith(w + '.')
  );
  if (isGreeting && session.step !== 'appt_name') {
    await sendWhatsAppButtons({
      ...helperParams,
      to: from,
      imageHeader: HOLI_IMG,
      body: `Hey there! 👋 Welcome to Choice Salon. ✨ Treat yourself to our premium hair spa, advanced coloring, or precision cuts. 💇‍♀️\n\nHow can we pamper you today?`,
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Now 📅' },
        { id: 'user_pricing', title: 'Prices & Offers 💰' },
        { id: 'user_ask_question', title: 'Ask a Question ❓' }
      ]
    });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }

  // 1. Handle Advanced Upsell - Step 1: Confirmation Request
  if (userMsg === 'upsell_add_mirror_shine') {
    try {
      // Find latest appointment for this user (schema uses 'phone')
      const lastAppt = await Appointment.findOne({ phone: from, clientId }).sort({ createdAt: -1 });

      if (lastAppt) {
        const baseService = lastAppt.service || 'Previous Service';
        const basePrice = lastAppt.revenue || 0;
        const upgradePrice = 4000;
        const totalPrice = basePrice + upgradePrice;

        // Send Confirmation Step
        await sendWhatsAppButtons({
          ...helperParams,
          to: from,
          imageHeader: HOLI_IMG,
          body: `💅 *Confirm Your Luxury Upgrade* ✨\n\nAre you sure you want to add *Mirror Shine Botosmooth* to your existing booking?\n\n*Current Selection:*\n💇‍♀️ ${baseService} (₹${basePrice})\n✨ Upgrade: Mirror Shine Botosmooth (₹${upgradePrice})\n\n💰 *Total Value: ₹${totalPrice}*\n\nIt's our absolute best treatment for a glass-like finish! 💎✨`,
          footer: 'You want to upgrade? 👇',
          buttons: [
            { id: 'upsell_confirm_mirror_shine', title: 'Yes, Upgrade ✅' },
            { id: 'upsell_reject_mirror_shine', title: 'No, Thanks ❌' }
          ]
        });
        res.status(200).end();
        return;
      } else {
        // Fallback if no appointment found
        console.log(`⚠️ No appointment found for upsell for ${from}`);
        await sendWhatsAppText({ ...helperParams, to: from, body: "I couldn't find your latest booking to update it. Please ask us in person!" });
        res.status(200).end();
        return;
      }
    } catch (err) {
      console.error('❌ Error in upsell confirmation step:', err);
    }
  }

  // 1a. Handle Advanced Upsell - Step 2: Confirmed execution
  if (userMsg === 'upsell_confirm_mirror_shine') {
    try {
      const lastAppt = await Appointment.findOne({ phone: from, clientId }).sort({ createdAt: -1 });

      if (lastAppt) {
        const upgradeService = 'Mirror Shine Botosmooth';
        const upgradePrice = 4000;

        // Check if already upgraded to prevent duplicate charges
        if (!lastAppt.service.includes(upgradeService)) {
          // Update Appointment in DB
          lastAppt.service += ` + ${upgradeService}`;
          lastAppt.revenue += upgradePrice;
          lastAppt.logs.push({
            action: 'update',
            changedBy: 'chatbot',
            source: 'chatbot',
            details: `User confirmed premium upsell: ${upgradeService}`
          });
          await lastAppt.save();
        }

        // Notify Admins
        const adminAlert = `💅 *Client Upgraded to Premium!*\n\n👤 *Client:* ${lastAppt.name}\n📱 *Phone:* ${from}\n📅 *Date:* ${lastAppt.date}\n🕒 *Time:* ${lastAppt.time}\n\n✨ *New Total Service:* ${lastAppt.service}\n💰 *Updated Revenue:* ${lastAppt.revenue}`;
        await notifyAdmins({ ...helperParams, message: adminAlert, adminNumbers });

        // Confirm to User
        await sendWhatsAppButtons({
          ...helperParams,
          to: from,
          imageHeader: HOLI_IMG,
          body: `✨ *Legendary Choice!* ✨\n\nI've updated your session to the ultimate luxury experience!\n\n✅ *Final Booking Details*\n👤 *Name:* ${lastAppt.name}\n📅 *Date:* ${lastAppt.date}\n🕒 *Time:* ${lastAppt.time}\n💇‍♀️ *Stylist:* ${lastAppt.doctor || 'Not specified'}\n💅 *Total Services:* ${lastAppt.service}\n\nsubhashbhai and the team will be ready for you. See you soon! 💅🧖‍♀️`,
          buttons: [
            { id: 'user_home', title: '🏠 Home' },
            { id: 'user_ask_question', title: '❓ Ask Question' }
          ]
        });

        res.status(200).end();
        return;
      } else {
        await sendWhatsAppText({ ...helperParams, to: from, body: "Sorry, I couldn't update your booking. Please check with us at the salon!" });
        res.status(200).end();
        return;
      }
    } catch (upsellErr) {
      console.error('❌ Error processing upsell confirmation:', upsellErr);
    }
  }

  // 1b. Handle Advanced Upsell - Step 2: Rejected
  if (userMsg === 'upsell_reject_mirror_shine') {
    await sendWhatsAppText({
      ...helperParams,
      to: from,
      body: `No worries at all! ✨ Your original booking is still confirmed. We can't wait to see you! 🧖‍♀️💅`
    });
    res.status(200).end();
    return;
  }

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

  // -----------------------------------------------------------
  // GLOBAL: "CALL ME" HANDLER — Works at any step in any flow
  // -----------------------------------------------------------
  if (userMsgType === 'text' && userMsg) {
    const callMeKeywords = [
      'call me', 'call karo', 'mane call karo', 'mane call karsho', 'please call',
      'call karjo', 'call kari lejo', 'phone karo', 'phone karjo', 'give me a call',
      'call back', 'ring me', 'contact me', 'please contact', 'tame call karo',
      'thoda call karo', 'call me please', 'please call me'
    ];
    const userMsgLower2 = userMsg.trim().toLowerCase();
    const isCallMeRequest = callMeKeywords.some(kw => userMsgLower2.includes(kw));

    if (isCallMeRequest) {
      // Notify all admins immediately
      const adminCallMsg = `📞 *Call Back Request!*\n\n👤 *Customer Phone:* ${from}\n💬 *Message:* "${userMsg}"\n\n_Please call this customer back as soon as possible!_ 🙏`;
      await notifyAdmins({ ...helperParams, message: adminCallMsg, adminNumbers });

      // Reply warmly to the user without breaking their flow
      await sendWhatsAppButtons({
        ...helperParams,
        to: from,
        body: `Absolutely. 📞 I've let the team know, and we'll give you a call back as soon as possible. 😊\n\nFeel free to keep chatting or booking here while you wait! ✨`,
        buttons: [
          { id: 'user_schedule_appt', title: 'Book Appt 📅' },
          { id: 'user_ask_question', title: 'Ask a Question ❓' }
        ]
      });
      // Do NOT reset session — let user continue from where they were
      res.status(200).end();
      return;
    }
  }

  // AI-powered free-text handling (not a button/list reply)
  if (userMsgType === 'text' && (!session.step || session.step === 'home' || session.step === 'home_waiting' || session.step === 'faq_menu' || session.step === 'appt_day' || session.step === 'appt_pick_day_waiting' || session.step === 'appt_time_waiting' || session.step === 'ask_question_topic' || session.step === 'faq_await')) {

    // Check if user is explicitly trying to book an appointment via text
    const bookingKeywords = [
      'book appointment', 'make appointment', 'schedule appointment', 'book visit',
      'see stylist', 'book salon session', 'appointment book kar', 'book karvu',
      'booking kar', 'time book', 'slot book', 'haircut karvu', 'spa karvu',
      'color karvu', 'treatment karvu', 'appoinment', 'booking chhe',
      'book karvanu', 'appointment joiye', 'appt book', 'book', 'booking'
    ];
    const userMsgLower = userMsg.toLowerCase();
    const isExplicitBooking = bookingKeywords.some(keyword => userMsgLower.includes(keyword));

    // Check if user typed a known service name (e.g., after viewing pricing)
    const typedServiceMatch = salonServices.find(s =>
      userMsgLower.includes(s.title.toLowerCase())
    );

    // If user is in FAQ/Ask Question flow, don't trigger booking automatically
    if (session.step === 'ask_question_topic' || session.step === 'faq_await') {
      // Handle as a general question, not booking
      console.log('User in FAQ flow, handling as question');
    } else if (typedServiceMatch) {
      // User typed a service name (e.g., after viewing pricing list). Start booking.
      session.data.chosenService = typedServiceMatch.title;
      session.data.chosenCategory = typedServiceMatch.category;
      session.data.chosenPrice = typedServiceMatch.price;
      session.data.stylist = 'subhashbhai';
      session.data.stylistId = 'stylist_subhashbhai';
      const days = await getAvailableBookingDays(session.data.stylistId, calendars);
      const cleanDays = days.map(day => ({ id: day.id, title: day.title }));
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: `🎈 ${typedServiceMatch.title}`,
        body: 'Great choice! Please select a day for your appointment:',
        button: 'Select Day',
        rows: cleanDays
      });
      session.data.calendarDays = days;
      session.step = 'calendar_pick_day';
      res.status(200).end();
      return;
    } else if (isExplicitBooking) {
      // Start the booking flow directly
      const paginatedServices = getPaginatedServices(0);
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Book Appointment 💇‍♀️',
        body: 'Perfect! Which service would you like to book? 😊',
        button: 'Select Service',
        rows: paginatedServices.services
      });
      session.step = 'choose_service';
      session.data.servicePage = 0;
      res.status(200).end();
      return;
    }

    // -------------------------------------------------------
    // GEMINI AI: Choice Salon Holi-specific, Gujinglish-aware prompt
    // -------------------------------------------------------
    const choiceSalonKnowledge = `
CHOICE SALON FOR LADIES — KNOWLEDGE BASE
======================================================
Business Name: Choice Salon (Ladies Only)
Owner / Master Stylist: Subhashbhai (15+ years experience)
Location: Second Floor, Raspan Arcade, 6-7, Raspan Cross Rd, opp. Gokul Party Plot, New India Colony, Nikol, Ahmedabad.
Contact: +91 98244 74547
Working Hours: Monday to Sunday, 10:00 AM to 8:00 PM
Payment: Cash, UPI, Credit/Debit cards

SERVICES & PRICING:
---------------------------------
Hair Spa:
  • Normal Spa: ₹1,000
  • Loreal Spa: ₹1,200
  • Silk Protein Spa: ₹1,500
  • Shea Butter Spa: ₹2,000
  • Permanent Spa: ₹2,000 (T&C apply)

Hair Treatments:
  • Nano Therapy: ₹3,500
  • Brazil Therapy: ₹3,000
  • Botox: ₹2,800
  • Keratin: ₹2,500
  • Mirror Shine Botosmooth: ₹4,000
  • Loreal Straightening: ₹3,500

Colour Services:
  • Global Color: ₹2,000
  • Root Touch Up: ₹1,000
  • Balayage Highlight: ₹2,500
  • Classic Highlight: ₹2,000

FAQ:
  Q: Does Subhashbhai do haircuts himself?
  A: Yes! Subhashbhai personally handles all services.
  Q: Is the salon for ladies only?
  A: Yes, Choice Salon is exclusively for ladies.
  Q: How to book an appointment?
  A: You can book directly in this chat. Just select a service and pick a date.
`;

    const prompt = `You are a friendly, human-like WhatsApp assistant for *Choice Salon for Ladies* in Ahmedabad, India. You work for Subhashbhai (the owner and master stylist).

CRITICAL LANGUAGE RULES:
- Users write in English, Gujarati, Hindi, or Gujinglish (Gujarati/Hindi words written in English letters mixed with English).
- You MUST understand Gujinglish. Here is a comprehensive dictionary:
    • "karse" / "kare che" = does/will do
    • "karvanu" / "karvu" / "karavi" = to do/get done
    • "joiye" / "joie" = need/want
    • "aavse" / "aave" = will come/is included
    • "chhe" / "che" = is/are
    • "shu" / "su" = what
    • "ketla" / "ketlu" = how much
    • "bhav" / "bhaav" = price/rate
    • "malshe" / "malse" = will get
    • "kevi rite" = how / in what way
    • "kyare" = when
    • "kya" / "kyaa" = where
    • "haa" / "ha" = yes
    • "na" / "nai" = no
    • "chalu" = open/running
    • "band" / "bandh" = closed
    • "owner" / "malik" / "sheth" = owner (Subhashbhai)
    • "bhabi"/ "bhabhi" = madam/wife
    • "hair smoothing" = hair straightening/keratin/botosmooth treatment
    • "price list" / "rate card" / "bhav patti" = pricing menu
    • "appointment" / "booking" / "schedule" = all mean booking
    • "talk to" / "vaat karvi" / "bolvu" = want to speak with
    • "mane" = me/to me
    • "tamne" = you/to you
    • "tame" = you (formal)
    • "kem cho" = how are you (greeting)
    • "maj ma" = I'm fine
    • "thik che" = it's okay
    • "karo" / "karsho" = please do (request)

COMMON QUERY MAPPINGS — understand these user intents:
    • "Hair smoothing price" / "smoothing ketla ma" = User asking about Keratin/Botosmooth/Straightening prices
    • "owner sathe vaat karvi" / "I want to talk to owner" / "malik ne connect karo" = wants to speak to Subhashbhai directly
    • "kal slot che?" / "tomorrow available?" = checking availability
    • "color ketla" / "colour price" = asking colour pricing
    • "spa ma su aave" = What's included in spa?
    • "appt date change karo" / "time badalvo che" / "cancel kro" / "appointment cancel karvi che" = asking to change or cancel appointment

RESPONSE RULES:
1. Keep replies SHORT (2-4 sentences max). No essays.
2. Be warm, friendly, and conversational — like a real person chatting on WhatsApp.
3. Use 1-2 emojis naturally. Don't overdo it.
4. This salon is ONLY for ladies. Never mention male services.
5. If someone asks about a service price, give the EXACT price from the knowledge base below.
6. If someone asks about "hair smoothing" / "straightening" — give prices for Keratin (₹2,500), Loreal Straightening (₹3,500), and Mirror Shine Botosmooth (₹4,000).
7. If someone says "I want to talk to owner" / "owner se baat karo" — say Subhashbhai is the owner and you can help book or answer questions, and mention they can also call +91 98244 74547.
8. Never say "I don't understand" or "I can't help". Always attempt to answer.
9. End with a natural follow-up like "Want to book? 😊" or "Anything else? ✨"
10. IMPORTANT: If the user explicitly asks to CANCEL an appointment, include the exact text [INTENT:CANCEL] anywhere in your reply.
11. IMPORTANT: If the user explicitly asks to RESCHEDULE or CHANGE the time/date of an appointment, include the exact text [INTENT:RESCHEDULE] anywhere in your reply.

CHOICE SALON KNOWLEDGE:
${choiceSalonKnowledge}

CUSTOMER MESSAGE: "${userMsg}"

Reply in short, friendly English:`;

    let aiResponse = '';
    let buttons = [];
    try {
      aiResponse = await generateWithGemini(geminiKey, prompt);

      // Parse intents to generate dynamic buttons
      if (aiResponse.includes('[INTENT:CANCEL]')) {
        aiResponse = aiResponse.replace(/\[INTENT:CANCEL\]/g, '').trim();
        buttons = [
          { id: 'user_cancel_appt', title: 'Cancel Appointment ❌' },
          { id: 'user_home', title: 'Start Over 🔄' }
        ];
      } else if (aiResponse.includes('[INTENT:RESCHEDULE]')) {
        aiResponse = aiResponse.replace(/\[INTENT:RESCHEDULE\]/g, '').trim();
        buttons = [
          { id: 'user_reschedule_appt', title: 'Reschedule Appt 📅' },
          { id: 'user_home', title: 'Start Over 🔄' }
        ];
      } else {
        // Default buttons
        buttons = [
          { id: 'user_schedule_appt', title: 'Book Appointment' },
          { id: 'user_ask_question', title: 'Ask a Question' }
        ];
      }

      if (!aiResponse.toLowerCase().includes('need anything else') &&
        !aiResponse.toLowerCase().includes('anything else') &&
        !aiResponse.toLowerCase().includes('help you') &&
        !buttons.some(b => b.id === 'user_cancel_appt' || b.id === 'user_reschedule_appt') &&
        !aiResponse.toLowerCase().includes('assistance')) {
        aiResponse += '\n\nNeed anything else I can help you with?';
      }
    } catch (err) {
      console.error('Gemini API error:', err);
      aiResponse = "I'm having trouble accessing information right now. Please try again, or use the buttons below.";
      buttons = [
        { id: 'user_schedule_appt', title: 'Book Appointment' },
        { id: 'user_ask_question', title: 'Ask a Question' }
      ];
    }

    // Send AI response with the dynamically chosen buttons
    await sendSmartButtonsOrList({
      ...helperParams,
      to: from,
      header: undefined,
      body: aiResponse,
      buttons: buttons
    });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }

  // Allow restart at any point
  if (userMsg === 'user_home' || userMsg === 'faq_home') {
    session.step = 'home';
    await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res, clientConfig, io });
    return;
  }

  // Home menu (step: 'home')
  // Handle global buttons (Home, Book Another, Ask Question)
  if (userMsg === 'user_home' || userMsg === 'home') {
    session.step = 'home';
    session.data = {};
    await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res, clientConfig, io });
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
    if (userMsg === 'user_schedule_appt') {
      await sendWhatsAppFlow({ ...helperParams, to: from, body: 'Awesome! Tap below to choose your service and secure your spot. 👇' });
      session.step = 'home_waiting';
      res.status(200).end();
      return;
    }
    await sendWhatsAppButtons({
      ...helperParams,
      to: from,
      imageHeader: HOLI_IMG,
      body: `Hey there! 👋 Welcome to Choice Salon. ✨ Treat yourself to our premium hair spa, advanced coloring, or precision cuts. 💇‍♀️\n\nHow can we pamper you today?`,
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Appt 📅' },
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
      // Launch Meta WhatsApp 2-Screen Booking Flow
      await sendWhatsAppFlow({
        ...helperParams,
        to: from,
        body: 'Awesome! Tap below to choose your service and secure your spot. 👇'
      });
      session.step = 'home_waiting';
      res.status(200).end();
      return;
    } else if (userMsg === 'user_cancel_appt' || userMsg === 'user_reschedule_appt') {
      // Direct the user to the database lookup flow instead of a static message
      session.step = userMsg === 'user_cancel_appt' ? 'cancel_lookup' : 'reschedule_lookup';
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res, clientConfig, io });
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
      // Send pricing image then immediately trigger the Meta Flow
      await sendWhatsAppImage({
        ...helperParams,
        to: from,
        imageUrl: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/public/images/p23.png`,
        caption: 'Choice Salon Holi Special – Services & Pricing 🎈'
      });
      await sendWhatsAppFlow({
        ...helperParams,
        to: from,
        body: 'Awesome! Tap below to choose your service and secure your spot. 👇'
      });
      session.step = 'home_waiting';
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

  // OLD FLOW: choose_service — now redirects to Meta WhatsApp Flow
  if (session.step === 'choose_service') {
    await sendWhatsAppFlow({ ...helperParams, to: from, body: 'Awesome! Tap below to choose your service and secure your spot. 👇' });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }


  // Deleted the choose_stylist step as requested.

  // Step 4: Date selection (calendar_pick_day) — now redirects to Meta WhatsApp Flow
  if (session.step === 'calendar_pick_day') {
    await sendWhatsAppFlow({ ...helperParams, to: from, body: 'Awesome! Tap below to choose your service and secure your spot. 👇' });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }

  // Step 5: Time slot selection (choose_time) — now redirects to Meta WhatsApp Flow
  if (session.step === 'choose_time') {
    await sendWhatsAppFlow({ ...helperParams, to: from, body: 'Let’s get you booked! Tap below to open our booking form 💇‍♀️' });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }

  // Appointment: Collect name (free text)
  // Step 6: Patient name (appt_name) — now redirects to Meta WhatsApp Flow
  if (session.step === 'appt_name') {
    await sendWhatsAppFlow({ ...helperParams, to: from, body: 'Let’s get you booked! Tap below to open our booking form 💇‍♀️' });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }


  // Appointment: Confirm with previous consent
  // Appointment: Confirm with previous consent — now redirects to Meta WhatsApp Flow
  if (session.step === 'appt_confirm_with_previous_consent') {
    await sendWhatsAppFlow({ ...helperParams, to: from, body: 'Let’s get you booked! Tap below to open our booking form 💇‍♀️' });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }

  // Step: Birthday Consent (appt_consent) — now redirects to Meta WhatsApp Flow
  if (session.step === 'appt_consent') {
    await sendWhatsAppFlow({ ...helperParams, to: from, body: 'Let’s get you booked! Tap below to open our booking form 💇‍♀️' });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
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
            { id: 'user_schedule_appt', title: 'Book Salon' },
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
            { id: 'user_schedule_appt', title: 'Book Salon' },
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
            { id: 'user_schedule_appt', title: 'Book Salon' },
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
            { id: 'user_schedule_appt', title: 'Book Salon' },
            { id: 'user_ask_question', title: 'Ask Question' },
            { id: 'user_home', title: 'Back to Menu' }
          ]
        });
      } else if (userMsg === 'faq_home') {
        session.step = 'home';
        await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res, clientConfig, io });
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
          // Delete old appointment looking up by either Google Calendar eventId OR MongoDB _id
          const cancelQuery = { clientId };
          if (session.data.cancelEventId.match(/^[0-9a-fA-F]{24}$/)) {
            cancelQuery._id = session.data.cancelEventId;
          } else {
            cancelQuery.eventId = session.data.cancelEventId;
          }

          await Appointment.findOneAndDelete(cancelQuery);
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
          header: 'Book Salon ⚽',
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
        header: 'Book Salon ⚽',
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
        { id: 'user_schedule_appt', title: 'Book Salon' },
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
      if (topic.id === 'ask_call_me') {
        const primaryAdmin = adminNumbers[0] || config.adminPhone || '919824474547';
        const adminChatLink = `https://wa.me/${primaryAdmin}`;
        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: `📞 You can call or WhatsApp Subhashbhai directly at +${primaryAdmin}.\n\nChat link: ${adminChatLink}`
        });
        session.step = 'home';
        res.status(200).end();
        return;
      } else if (topic.id === 'ask_other') {
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
    console.log('[CHOICE SALON WEBHOOK RAW PAYLOAD]:', JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = value?.messages?.[0];
    const phoneNumberId = value?.metadata?.phone_number_id;
    const from = messages?.from;

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
        messages.type === 'button' ? messages.button?.text :
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
      conversation.unreadCount = (conversation.unreadCount || 0) + 1;
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

const handleFlowWebhook = async (req, res) => {
  try {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

    // 1. Decrypt AES Key
    const privateKey = fs.readFileSync(path.join(process.cwd(), 'private.pem'), 'utf8');
    const aesKey = crypto.privateDecrypt({
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    }, Buffer.from(encrypted_aes_key, 'base64'));

    const algorithm = `aes-${aesKey.length * 8}-gcm`;

    // 2. Decrypt Flow Data
    const iv = Buffer.from(initial_vector, 'base64');
    const flowDataBuffer = Buffer.from(encrypted_flow_data, 'base64');
    const authTagLength = 16;
    const authTag = flowDataBuffer.slice(flowDataBuffer.length - authTagLength);
    const ciphertext = flowDataBuffer.slice(0, flowDataBuffer.length - authTagLength);

    const decipher = crypto.createDecipheriv(algorithm, aesKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    const decryptedBody = JSON.parse(decrypted);

    console.log('[Choice Salon Flow] Decrypted Action:', decryptedBody.action);

    let responsePayload = {};

    // 3. Strict Routing matching the Flow JSON
    switch (decryptedBody.action) {
      case 'ping':
        responsePayload = { data: { status: "active" } };
        break;

      case 'INIT':
        // Meta's first ping when opening the flow
        responsePayload = {
          screen: "HOLI_BOOKING_SCREEN",
          data: {}
        };
        break;

      case 'data_exchange': {
        // Triggered by the "Find Available Slots" footer button
        const service = decryptedBody.data?.service || 'cut_advance';
        const date = decryptedBody.data?.date || new Date().toISOString().split('T')[0];

        console.log(`[Choice Salon Flow] Fetching slots for ${service} on ${date}`);

        let formattedSlotsArray = [];
        try {
          const { config } = req.clientConfig;
          const calendars = { ...stylistCalendars, ...(config.calendars || {}) };

          let allSlots = [];
          let currentPage = 0;
          let fetching = true;

          // Loop to gather all pages of slots
          while (fetching) {
            const result = await fetchRealTimeSlots(date, currentPage, 'subhashbhai', calendars);
            const currentSlots = result.slots || [];

            // Check if the old pagination "Show more" button exists
            // (It usually has an id like 'show_more' or 'more_slots')
            const showMoreIndex = currentSlots.findIndex(s =>
              s.id === 'show_more' ||
              s.id === 'more_slots' ||
              (s.title && s.title.toLowerCase().includes('more slots'))
            );

            if (showMoreIndex !== -1) {
              // Grab everything before the "Show more" fake slot
              allSlots.push(...currentSlots.slice(0, showMoreIndex));
              currentPage++; // Move to the next page
            } else {
              // No "Show more" found, this is the last page
              allSlots.push(...currentSlots);
              fetching = false;
            }

            // Failsafe to prevent infinite loops (max 10 pages)
            if (currentPage > 10) fetching = false;
          }

          formattedSlotsArray = allSlots.map(s => ({
            id: s.id,
            title: s.title
          }));

          console.log(`[Choice Salon Flow] Got ${formattedSlotsArray.length} total slots for ${date}`);
        } catch (slotError) {
          console.error('[Choice Salon Flow] Error fetching slots:', slotError);
        }

        // Fallback if no slots exist to prevent UI crash
        if (formattedSlotsArray.length === 0) {
          formattedSlotsArray = [{ id: 'no_slots', title: 'No slots available' }];
        }

        responsePayload = {
          screen: "TIME_AND_DETAILS_SCREEN",
          data: {
            selected_service: service,
            selected_date: date,
            available_slots: formattedSlotsArray
          }
        };
        break;
      }

      default:
        console.warn('[Choice Salon Flow] Unknown action received:', decryptedBody.action);
        responsePayload = { screen: "HOLI_BOOKING_SCREEN", data: {} }; // Safe fallback
        break;
    }

    // 4. Encrypt Response (Using strict Buffer map for bitwise NOT)
    const flippedIvBuffer = Buffer.from(iv.map(b => ~b & 0xFF));
    const cipher = crypto.createCipheriv(algorithm, aesKey, flippedIvBuffer);

    const responseCiphertext = cipher.update(JSON.stringify(responsePayload), 'utf8');
    const finalBuffer = cipher.final();
    const authTagOut = cipher.getAuthTag();

    const encryptedPayload = Buffer.concat([responseCiphertext, finalBuffer, authTagOut]);

    // Send strictly as text/plain
    res.status(200).set('Content-Type', 'text/plain').send(encryptedPayload.toString('base64'));

  } catch (error) {
    console.error('[Choice Salon Flow] Critical Endpoint Error:', error);
    res.status(500).send('Internal Server Error');
  }
};

router.handleWebhook = handleWebhook;
router.handleFlowWebhook = handleFlowWebhook;
module.exports = router;
