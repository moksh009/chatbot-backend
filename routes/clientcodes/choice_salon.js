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

const SALON_IMG = 'https://instagram.famd1-2.fna.fbcdn.net/v/t51.2885-19/436333745_1497177940869325_2985750738127060080_n.jpg?efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLmRqYW5nby4xMDgwLmMyIn0&_nc_ht=instagram.famd1-2.fna.fbcdn.net&_nc_cat=101&_nc_oc=Q6cZ2QH8vCGf2jGUX3lSsvjRV2axzhtJLYNHfIbhUn1TQkvNKEvnx4XWgdyKCrgXVx8KsC9Pq5Fgfk9UcjXn18wL8ThL&_nc_ohc=8-CBI_zJuBwQ7kNvwEeJ635&_nc_gid=Gp62ZusslBSvo5TFvcyJAg&edm=ALGbJPMBAAAA&ccb=7-5&oh=00_AftGK8L_C4HRW6SdWj31MRppEsoQ-N4fEB14vEohvB7zrA&oe=69A1B22C&_nc_sid=7d3ac5';

// Add at the top for topic list
const QUESTION_TOPICS = [
  { id: 'ask_services', title: 'Services' },
  { id: 'ask_pricing', title: 'Pricing' },
  { id: 'ask_appointments', title: 'Booking' },
  { id: 'ask_other', title: 'Something else' }
];

const FAQ_DATA = {
  'ask_services': [
    { id: 'faq_serv_types', title: 'What services do you offer?', answer: 'We offer ladies haircuts, advanced hair spa, protein and straightening treatments, global color, highlights, and more. Biji badhi details mate tame ahi booking kari shako cho! ✨' },
    { id: 'faq_serv_kids', title: 'Do you do kids haircuts?', answer: 'Yes. We provide haircuts for girls of all ages. Chokriyo mate best service malshe! 👧' },
    { id: 'faq_serv_color', title: 'Do you do hair color?', answer: 'Yes. We offer professional global color and highlights with proper hair care guidance. Quality color kaam thai jashe! 🎨' },
    { id: 'faq_serv_spa', title: 'Do you offer hair spa?', answer: 'Yes. We have multiple hair spa options including Normal Spa, Loreal Spa, Silk Protein Spa, Shea Butter Spa, and Permanent Spa. Hair mate best spa results malshe! 🧖‍♀️' }
  ],
  'ask_pricing': [
    { id: 'faq_price_haircut', title: 'How much is a haircut?', answer: 'Our Haircut is ₹500 and Advance Haircut is ₹700 for ladies.' },
    { id: 'faq_price_list', title: 'Full Price List', answer: 'Here is our latest price list:\n\nHaircut\n• Haircut: ₹500/-\n• Advance Haircut: ₹700/-\n\nHair Spa\n• Normal Spa: ₹1,000/-\n• Loreal Spa: ₹1,200/-\n• Silk Protein Spa: ₹1,500/-\n• Shea Butter Spa: ₹2,000/-\n• Permanent Spa: ₹2,000/-\n\nHair Treatment\n• Nano Therapy: ₹3,500/-\n• Brazil Therapy: ₹3,000/-\n• Botox: ₹2,800/-\n• Keratin: ₹2,500/-\n• Mirror Shine Boto Smooth: ₹4,000/-\n• Loreal Straightening: ₹3,500/-\n\nColour\n• Global Color: ₹2,000/-\n• Root Touch Up: ₹1,000/-\n• Balayage Highlight: ₹2,500/-\n• Classic Highlight: ₹2,000/-' },
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
  try {
    // gemini-2.5-flash — gemini-2.0-flash is deprecated (404 for new users)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
    const resp = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
    const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text.trim();
  } catch (err) {
    console.error('Gemini API Error (choice_salon):', err.message);
    return "Hi! 😊 Our AI system is currently updating its knowledge base. Please select from the menu options below or contact the salon directly!";
  }
}
const salonServices = [
  { id: 'svc_haircut_basic', title: 'Haircut', price: '₹500/-', description: '₹500/-', category: 'Haircut' },
  { id: 'svc_haircut_advance', title: 'Advance Haircut', price: '₹700/-', description: '₹700/-', category: 'Haircut' },
  { id: 'svc_spa_normal', title: 'Normal Spa', price: '₹1,000/-', description: '₹1,000/-', category: 'Hair Spa' },
  { id: 'svc_spa_loreal', title: 'Loreal Spa', price: '₹1,200/-', description: '₹1,200/-', category: 'Hair Spa' },
  { id: 'svc_spa_silk', title: 'Silk Protein Spa', price: '₹1,500/-', description: '₹1,500/-', category: 'Hair Spa' },
  { id: 'svc_spa_shea', title: 'Shea Butter Spa', price: '₹2,000/-', description: '₹2,000/-', category: 'Hair Spa' },
  { id: 'svc_spa_perm', title: 'Permanent Spa', price: '₹2,000/-', description: '₹2,000/-', category: 'Hair Spa' },
  { id: 'svc_treat_nano', title: 'Nano Therapy', price: '₹3,500/-', description: '₹3,500/-', category: 'Hair Treatment' },
  { id: 'svc_treat_brazil', title: 'Brazil Therapy', price: '₹3,000/-', description: '₹3,000/-', category: 'Hair Treatment' },
  { id: 'svc_treat_botox', title: 'Botox', price: '₹2,800/-', description: '₹2,800/-', category: 'Hair Treatment' },
  { id: 'svc_treat_keratin', title: 'Keratin', price: '₹2,500/-', description: '₹2,500/-', category: 'Hair Treatment' },
  { id: 'svc_treat_mirror', title: 'Mirror Shine Boto Smooth', price: '₹4,000/-', description: '₹4,000/-', category: 'Hair Treatment' },
  { id: 'svc_treat_loreal_straight', title: 'Loreal Straightening', price: '₹3,500/-', description: '₹3,500/-', category: 'Hair Treatment' },
  { id: 'svc_color_global', title: 'Global Color', price: '₹2,000/-', description: '₹2,000/-', category: 'Colour' },
  { id: 'svc_color_roots', title: 'Root Touch Up', price: '₹1,000/-', description: '₹1,000/-', category: 'Colour' },
  { id: 'svc_color_balayage', title: 'Balayage Highlight', price: '₹2,500/-', description: '₹2,500/-', category: 'Colour' },
  { id: 'svc_color_classic', title: 'Classic Highlight', price: '₹2,000/-', description: '₹2,000/-', category: 'Colour' }
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
  { category: 'Haircut', service: 'Haircut', price: '500/-' },
  { category: 'Haircut', service: 'Advance Haircut', price: '700/-' },
  { category: 'Hair Spa', service: 'Normal Spa', price: '1,000/-' },
  { category: 'Hair Spa', service: 'Loreal Spa', price: '1,200/-' },
  { category: 'Hair Spa', service: 'Silk Protein Spa', price: '1,500/-' },
  { category: 'Hair Spa', service: 'Shea Butter Spa', price: '2,000/-' },
  { category: 'Hair Spa', service: 'Permanent Spa * T&C apply, pricing depends on length', price: '2,000/-' },
  { category: 'Hair Treatment', service: 'Nano Therapy', price: '3,500/-' },
  { category: 'Hair Treatment', service: 'Brazil Therapy', price: '3,000/-' },
  { category: 'Hair Treatment', service: 'Botox', price: '2,800/-' },
  { category: 'Hair Treatment', service: 'Keratin', price: '2,500/-' },
  { category: 'Hair Treatment', service: 'Mirror Shine Botosmooth', price: '4,000/-' },
  { category: 'Hair Treatment', service: 'Loreal Straightening', price: '3,500/-' },
  { category: 'Colour', service: 'Global Color', price: '2,000/-' },
  { category: 'Colour', service: 'Root Touch Up', price: '1,000/-' },
  { category: 'Colour', service: 'Balayage Highlight', price: '2,500/-' },
  { category: 'Colour', service: 'Classic Highlight', price: '2,000/-' }
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
      footer: footer ? { text: footer } : (false ? { text: 'Choice Salon Holi Offer 🌈' } : { text: 'Choice Salon for Ladies 💅' }),
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

// Helper: Send Native Meta WhatsApp Flow
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
          flow_id: process.env.META_FLOW_ID || '1177699103681531',
          flow_cta: 'Open Booking Flow',
          flow_action: 'navigate',
          flow_action_payload: {
            screen: 'HOLI_BOOKING_SCREEN'
          }
        }
      }
    }
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
    conversation.lastMessage = 'Sent Booking Flow';
    conversation.lastMessageAt = new Date();
    await conversation.save();

    await saveAndEmitMessage({
      clientId,
      from: 'bot',
      to,
      body: 'Sent Booking Flow',
      type: 'interactive',
      direction: 'outgoing',
      status: 'sent',
      conversationId: conversation._id,
      io
    });

  } catch (err) {
    console.error('Error sending WhatsApp flow:', err.response?.data || err.message);
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
  console.log(`[CHOICE_SALON] Gemini key source: ${geminiApiKey ? 'DB/Middleware' : 'Env Fallback'}, len=${geminiKey?.length || 0}`);
  if (!geminiKey) console.warn('[CHOICE_SALON] ⚠️ No Gemini API key found! AI replies will fail.');

  const session = getUserSession(from);
  const userMsgType = messages.type;
  const userMsg = userMsgType === 'interactive' ? (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id) : messages.text?.body;

  // Pass common params to helpers
  const helperParams = { phoneNumberId, token, io, clientId };

  // ===================================================================
  // META WHATSAPP FLOW NFM_REPLY HANDLER & VERIFICATION BRIDGE
  // ===================================================================
  if (userMsgType === 'interactive' && messages.interactive?.type === 'nfm_reply') {
    try {
      const responseJson = JSON.parse(messages.interactive.nfm_reply.response_json);
      const service = responseJson.selected_service;
      const date = responseJson.selected_date;
      const time = responseJson.selected_time;
      const customer_name = responseJson.customer_name;

      // Verification Bridge: Check if slot is actually available
      const result = await fetchRealTimeSlots(date, 0, 'subhashbhai', calendars);
      const isAvailable = result.slots.some(s => s.id === time || s.title === time);

      if (!isAvailable) {
        await sendWhatsAppFlow({ ...helperParams, to: from, body: `Sorry! The slot for *${time}* on *${date}* just got booked! Please select a new time below ⬇️` });
        session.step = 'flow_in_progress';
      } else {
        // Build final appointment object directly
        const appointmentData = {
          clientId,
          phone: from,
          name: customer_name,
          service,
          date,
          time,
          doctor: 'subhashbhai',
          status: 'confirmed',
          createdAt: new Date(),
          source: 'chatbot'
        };

        await Appointment.create(appointmentData);

        // Sync with Google Calendar
        const calendarId = calendars['subhashbhai'];
        const startTime = DateTime.fromFormat(`${date} ${time}`, 'dd/MM/yyyy h:mm a', { zone: 'Asia/Kolkata' }).toISO();
        const endTime = DateTime.fromISO(startTime).plus({ minutes: 60 }).toISO();

        const eventDetails = {
          summary: `Appointment: ${customer_name}`,
          description: `Service: ${service}\nPhone: ${from}`,
          startTime,
          endTime,
        };
        await createEvent(calendarId, eventDetails);

        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: `✨ *Legendary Choice!* ✨\n\nI've confirmed your booking!\n\n✅ *Final Booking Details*\n👤 *Name:* ${customer_name}\n📅 *Date:* ${date}\n🕒 *Time:* ${time}\n💇‍♀️ *Stylist:* subhashbhai\n💅 *Total Services:* ${service}\n\nsubhashbhai and the team will be ready for you. See you soon! 💅🧖‍♀️`
        });

        // Trigger Upsell
        await sendWhatsAppButtons({
          ...helperParams,
          to: from,
          imageHeader: SALON_IMG,
          body: `💅 *Confirm Your Luxury Upgrade* ✨\n\nAre you sure you want to add *Mirror Shine Botosmooth* to your existing booking?\n\nIt's our absolute best treatment for a glass-like finish! 💎✨`,
          footer: 'You want to upgrade? 👇',
          buttons: [
            { id: 'upsell_confirm_mirror_shine', title: 'Yes, Upgrade ✅' },
            { id: 'upsell_reject_mirror_shine', title: 'No, Thanks ❌' }
          ]
        });

        session.step = 'home';
      }
      res.status(200).end();
      return;
    } catch (e) {
      console.error('Flow Reply Error:', e);
      // Fallback
      await sendWhatsAppFlow({ ...helperParams, to: from, body: 'Something went wrong processing your booking. Let us try that again!' });
      res.status(200).end();
      return;
    }
  }

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

    const primaryAdmin = adminNumbers[0] || config.adminPhone || '919824474547';
    const adminChatLink = `https://wa.me/${primaryAdmin}`;

    await sendWhatsAppButtons({
      ...helperParams,
      to: from,
      body: `Thanks for sharing that ${mediaLabel.toLowerCase()}! 📸\n\nOur bot can only process text messages right now, but we've forwarded your ${mediaLabel.toLowerCase()} to Subhashbhai.\n\nYou can also chat with him directly 👇`,
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Appointment 📅' },
        { id: 'user_ask_question', title: 'Ask a Question ❓' }
      ]
    });
    await sendWhatsAppText({
      ...helperParams, to: from,
      body: `📞 Chat with Subhashbhai directly:\n${adminChatLink}`
    });
    res.status(200).end();
    return;
  }

  // If userMsg is empty/undefined (reaction, unknown type), just ack
  if (!userMsg && userMsgType !== 'interactive') {
    res.status(200).end();
    return;
  }

  // -----------------------------------------------------------
  // GLOBAL COMMANDS (STOP, START, GREETINGS) - MUST BE CHECKED FIRST
  // -----------------------------------------------------------

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

  // If user sends a greeting, always globally reset and show the main menu with buttons
  const msgLower = (userMsgType === 'text' && userMsg) ? userMsg.trim().toLowerCase() : '';
  const isGreeting = msgLower && GREETING_WORDS.some(w =>
    msgLower === w || msgLower.startsWith(w + ' ') || msgLower.startsWith(w + ',') || msgLower.startsWith(w + '!') || msgLower.startsWith(w + '.')
  );
  if (isGreeting && session.step !== 'appt_name') {
    await sendWhatsAppButtons({
      ...helperParams,
      to: from,
      imageHeader: SALON_IMG,
      body: 'Hi 👋\n\nThis is subhashbhai from Choice Salon! ✨ Welcome to our virtual assistant. How can I help you today? ✨',
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Appointment 📅' },
        { id: 'user_pricing', title: 'Pricing 💰' },
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
          imageHeader: SALON_IMG,
          body: `💅 *Confirm Your Luxury Upgrade* ✨\n\nAre you sure you want to add *Mirror Shine Botosmooth* to your existing booking?\n\n*Current Selection:*\n💇‍♀️ ${baseService} (₹${basePrice})\n✨ Upgrade: Mirror Shine Botosmooth (₹${upgradePrice})\n\n💰 *Total Value: ₹${totalPrice}*\n\nIt's our absolute best treatment for a glass-like finish! 💎✨`,
          footer: 'Choose your preference below 👇',
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
          imageHeader: SALON_IMG,
          body: `✨ *Legendary Choice!* ✨\n\nI've updated your session to the ultimate luxury experience!\n\n✅ *Final Booking Details*\n👤 *Client:* ${lastAppt.name}\n📅 *Date:* ${lastAppt.date}\n🕒 *Time:* ${lastAppt.time}\n💇‍♀️ *Stylist:* ${lastAppt.doctor || 'Not specified'}\n💅 *Total Services:* ${lastAppt.service}\n\nsubhashbhai and the team will be ready for you. See you soon! 💅🧖‍♀️`,
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
        body: `Sure! 📞 We've notified our team and someone will call you back shortly. 😊\n\nIn the meantime, you can still book an appointment or ask anything here! 💅✨`,
        buttons: [
          { id: 'user_schedule_appt', title: 'Book Appointment 📅' },
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
      'book karvanu', 'appointment joiye', 'appt book'
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
      // User typed a service name (e.g., after viewing pricing list)
      session.data.chosenService = typedServiceMatch.title;
      session.data.chosenCategory = typedServiceMatch.category;
      session.data.chosenPrice = typedServiceMatch.price;
      await sendSmartButtonsOrList({
        ...helperParams,
        to: from,
        header: `${typedServiceMatch.title} – ${typedServiceMatch.price}`,
        body: `Great choice! For *${typedServiceMatch.title}*, which stylist would you prefer?`,
        buttons: salonStylists.map(s => ({ id: s.id, title: s.title }))
      });
      session.step = 'choose_stylist';
      res.status(200).end();
      return;
    } else if (isExplicitBooking) {
      // Start the booking flow directly
      const paginatedServices = getPaginatedServices(0);
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'Book Appointment 💇‍♀️',
        body: 'Perfect! I\'d be happy to help you book an appointment. 😊 Which service do you need?',
        button: 'Select Service',
        rows: paginatedServices.services
      });
      session.step = 'choose_service';
      session.data.servicePage = 0;
      res.status(200).end();
      return;
    }

    // -------------------------------------------------------
    // GEMINI AI: Choice Salon-specific, Gujinglish-aware prompt
    // -------------------------------------------------------
    const choiceSalonKnowledge = `
CHOICE SALON FOR LADIES — KNOWLEDGE BASE
=========================================
Business Name: Choice Salon (Ladies Only)
Owner / Master Stylist: Subhashbhai (15+ years experience)
Location: Second Floor, Raspan Arcade, 6-7, Raspan Cross Rd, opp. Gokul Party Plot, New India Colony, Nikol, Ahmedabad.
Contact: +91 98244 74547
Working Hours: Monday to Sunday, 10:00 AM to 8:00 PM
Payment: Cash, UPI, Credit/Debit cards

SERVICES & PRICING:
-------------------
Haircut:
  • Haircut: ₹500
  • Advance Haircut: ₹700

Hair Spa:
  • Normal Spa: ₹1,000
  • Loreal Spa: ₹1,200
  • Silk Protein Spa: ₹1,500
  • Shea Butter Spa: ₹2,000
  • Permanent Spa: ₹2,000 (T&C apply, price depends on hair length)

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
  A: Yes! Subhashbhai personally handles all services. He is the master stylist.
  Q: Is the salon for ladies only?
  A: Yes, Choice Salon is exclusively for ladies.
  Q: How to book?
  A: You can book directly in this chat.
  Q: Can I walk in?
  A: Walk-ins are welcome, but booking in advance is recommended.
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
    • "bhabi" / "bhabhi" = madam/wife
    • "hair smoothing" = hair straightening/keratin/botosmooth treatment
    • "price list" / "rate card" / "bhav patti" = pricing menu
    • "appointment" / "booking" / "schedule" = all mean booking
    • "talk to" / "vaat karvi" / "bolvu" = want to speak with
    • "mane" = me/to me
    • "tame" = you (formal)
    • "kem cho" = how are you (greeting)
    • "karo" / "karsho" = please do (request)

COMMON QUERY MAPPINGS — understand these user intents:
    • "Hair smoothing price" / "smoothing ketla ma" = asking about Keratin/Botosmooth/Straightening prices
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
7. If someone says "I want to talk to owner" — say Subhashbhai is the owner and you can help here, or they can call +91 98244 74547.
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
    await sendWhatsAppButtons({
      ...helperParams,
      to: from,
      imageHeader: SALON_IMG,
      body: 'Hi 👋\n\nThis is subhashbhai from Choice Salon! ✨ Welcome to our virtual assistant. How can I help you today? ✨',
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Appointment 📅' },
        { id: 'user_pricing', title: 'Pricing 💰' },
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
      await sendWhatsAppFlow({ ...helperParams, to: from });
      session.step = 'flow_in_progress';
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
      // Send the pricing image first
      await sendWhatsAppImage({
        ...helperParams,
        to: from,
        imageUrl: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/public/images/p23.png`,
        caption: 'Choice Salon Services & Pricing 💅'
      });
      // Then immediately send a service selection list so the flow continues
      const paginatedServices = getPaginatedServices(0);
      await sendWhatsAppList({
        ...helperParams,
        to: from,
        header: 'What would you like to book? 😊',
        body: 'Select a service below to book your appointment:',
        button: 'Choose Service',
        rows: paginatedServices.services
      });
      session.step = 'choose_service';
      session.data.servicePage = 0;
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
    // AI Fallback: users typing instead of clicking buttons
    if (userMsgType === 'text') {
      session.step = 'faq_await';
      return await handleUserChatbotFlow({ from, phoneNumberId, messages, res, clientConfig, io });
    }

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
    // AI Fallback: users typing instead of clicking buttons
    if (userMsgType === 'text') {
      session.step = 'faq_await';
      return await handleUserChatbotFlow({ from, phoneNumberId, messages, res, clientConfig, io });
    }

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
    // AI Fallback: users typing instead of clicking buttons
    if (userMsgType === 'text') {
      session.step = 'faq_await';
      return await handleUserChatbotFlow({ from, phoneNumberId, messages, res, clientConfig, io });
    }

    let time = '';
    let selectedSlot = null;
    // Support slot pagination and selection
    if (userMsg && userMsg.startsWith('slot_')) {
      if (userMsg.startsWith('slot_next')) {
        // Handle any slot_next_* ID
        const currentPage = session.data.slotPage || 0;
        session.data.slotPage = currentPage + 1;
        session.step = 'calendar_pick_day';
        await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res, clientConfig, io });
        return;
      } else if (userMsg === 'slot_prev') {
        session.data.slotPage = Math.max((session.data.slotPage || 0) - 1, 0);
        session.step = 'calendar_pick_day';
        await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res, clientConfig, io });
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
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res, clientConfig, io });
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
            let footerText = '';
            if (lastAppointment.consent.appointmentReminders && lastAppointment.consent.birthdayMessages) {
              consentStatus = '✅ Accept All';
              footerText = '⭐ Your previous preference: Accept All';
            } else if (lastAppointment.consent.appointmentReminders) {
              consentStatus = '📅 Reminders Only';
              footerText = '📅 Your previous preference: Reminders';
            } else {
              consentStatus = '❌ No Thanks';
              footerText = '❌ Your previous preference: No Comms';
            }

            let confirmationBody = `✅ *Booking Summary*\n\n` +
              `👤 *Name:* ${session.data.name}\n` +
              `📅 *Date:* ${session.data.date}\n` +
              `🕒 *Time:* ${session.data.time}\n` +
              `💇‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n` +
              `💅 *Service:* ${session.data.chosenService || 'General Salon Session'}\n\n` +
              `📱 *Phone:* ${session.data.phone}`;

            // Store the previous consent for this booking so it can be used on confirm
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
              imageHeader: SALON_IMG,
              body: confirmationBody,
              footer: footerText,
              buttons: [
                { id: 'confirm_with_previous_consent', title: 'Confirm ✅' },
                { id: 'change_consent_preferences', title: 'Change 🔄' }
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
          imageHeader: SALON_IMG,
          body: `✨ *Review Your Booking* ✨

👤 *Client:* ${session.data.name}
📅 *Date:* ${session.data.date}
🕒 *Time:* ${session.data.time}
💇‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}
💅 *Service:* ${session.data.chosenService || 'General Salon Session'}

📱 *Contact:* ${session.data.phone}`,
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
          imageHeader: SALON_IMG,
          body: `✨ *Review Your Booking* ✨

👤 *Client:* ${session.data.name}
📅 *Date:* ${session.data.date}
🕒 *Time:* ${session.data.time}
💇‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}
💅 *Service:* ${session.data.chosenService || 'General Salon Session'}

📱 *Contact:* ${session.data.phone}`,
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

        // Check if the time slot has reached its 4-person capacity
        try {
          const availableSlots = await getAvailableTimeSlots({
            date: session.data.date,
            startTime: '00:00',
            endTime: '23:59',
            calendarId,
            clientId: 'choice_salon',
            doctor: session.data.stylist,
            capacity: 4
          });

          const isSlotAvailable = availableSlots.some(slot => {
            const sStart = DateTime.fromISO(slot.start);
            const sEnd = DateTime.fromISO(slot.end);
            return (slotStart >= sStart && slotEnd <= sEnd);
          });

          if (!isSlotAvailable) {
            throw new Error('This time slot is now full. Please choose a different time.');
          }
        } catch (checkError) {
          if (checkError.message.includes('now full')) throw checkError;
          console.warn('⚠️ Capacity check warning:', checkError.message);
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
          footer: ''`;

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
          // Send Premium Interactive Upsell
          await sendWhatsAppButtons({
            ...helperParams,
            to: from,
            imageHeader: SALON_IMG,
            body: `✨ *Ultimate Glow-Up!* ✨\n\nYou're already booked, but why not make it spectacular? 💎\n\nUpgrade to our *Mirror Shine Botosmooth* (₹4,000) for that ultimate glass-like finish. 💅✨\n\n*Only 2 premium slots remaining today!*`,
            footer: 'Limited availability! Tap below to upgrade 👇',
            buttons: [
              { id: 'upsell_add_mirror_shine', title: 'Add to Booking 💅' }
            ]
          });
          console.log(`✅ Advanced interactive upsell sent to ${from}`);
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

        // Check if the time slot has reached its 4-person capacity
        try {
          const availableSlots = await getAvailableTimeSlots({
            date: session.data.date,
            startTime: '00:00',
            endTime: '23:59',
            calendarId,
            clientId: 'choice_salon',
            doctor: session.data.stylist,
            capacity: 4
          });

          const isSlotAvailable = availableSlots.some(slot => {
            const sStart = DateTime.fromISO(slot.start);
            const sEnd = DateTime.fromISO(slot.end);
            return (slotStart >= sStart && slotEnd <= sEnd);
          });

          if (!isSlotAvailable) {
            throw new Error('This time slot is now full. Please choose a different time.');
          }
        } catch (checkError) {
          if (checkError.message.includes('now full')) throw checkError;
          console.warn('⚠️ Capacity check warning:', checkError.message);
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
      let confirmationBody = `✅ *Booking Confirmed*\n\n` +
        `👤 *Client:* ${session.data.name}\n` +
        `📅 *Date:* ${session.data.date}\n` +
        `🕒 *Time:* ${session.data.time}\n` +
        `💇‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n` +
        `💅 *Service:* ${session.data.chosenService || 'General Session'}\n\n` +
        `📍 *Choice Salon for Ladies, Nikol*\n` +
        `🏢 2nd Floor, Raspan Arcade, 6-7, Nikol\n` +
        `🗺️ Map: https://maps.google.com/?q=Choice+Salon+Raspan+Arcade+Nikol\n\n` +
        `⏰ *Please arrive 15 minutes early*`;

      let footerText = '❌ To stop receiving messages, reply with "STOP"';
      if (session.data.consent.appointmentReminders) {
        footerText = '🔔 Reminders active. Reply STOP to opt-out.';
      }

      await sendWhatsAppButtons({
        ...helperParams,
        to: from,
        imageHeader: SALON_IMG,
        body: confirmationBody,
        footer: footerText,
        buttons: [
          { id: 'book_another', title: '📅 Book Another' },
          { id: 'user_ask_question', title: '❓ Ask Question' },
          { id: 'user_home', title: '🏠 Home' }
        ]
      });

      // Send Advanced Upsell message after 5 minutes (300,000 ms)
      setTimeout(async () => {
        try {
          // Send Premium Interactive Upsell
          await sendWhatsAppButtons({
            ...helperParams,
            to: from,
            imageHeader: SALON_IMG,
            body: `✨ *Ultimate Glow-Up!* ✨

You're already booked, but why not make it spectacular? 💎

Upgrade to our *Mirror Shine Boto Smooth* (₹4,000) for that ultimate glass-like finish. 💅✨

*Only 2 premium slots remaining today!*`,
            footer: 'Limited availability! Tap below to upgrade 👇',
            buttons: [
              { id: 'upsell_add_mirror_shine', title: 'Add to Booking 💅' }
            ]
          });
          console.log(`✅ Advanced interactive upsell sent to ${from}`);
        } catch (err) {
          console.error(`❌ Error sending advanced upsell to ${from}:`, err);
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

    // Enhanced OpenAI prompt for FAQ responses & Zero-Click Extraction
    const prompt = `You are Ava, a friendly and knowledgeable assistant for Choice Salon in Ahmedabad.

IMPORTANT INSTRUCTIONS (CRITICAL):
1. You MUST ALWAYS output ONLY standard JSON format. No markdown blocks, no text before or after.
2. If the user is asking a basic question, answer it in the "answer" field.
3. If the user is trying to book an appointment (e.g. "book a haircut for tomorrow at 2pm"), extract as much as you can.
4. Your JSON MUST match this exact schema:
{
  "service": "String or null",
  "date": "String (DD/MM/YYYY) or null",
  "time": "String (HH:MM AM/PM) or null",
  "customer_name": "String or null",
  "answer": "String (Your helpful reply to a question, or null if booking)",
  "next_action": "answer_faq" | "trigger_flow" | "skip_to_booking"
}
5. Set "next_action" to "answer_faq" if they are just asking questions.
6. Set "next_action" to "trigger_flow" if they want to book but are missing details like time or date.
7. Set "next_action" to "skip_to_booking" ONLY if service, date, time, and customer_name are all successfully extracted.

KNOWLEDGE BASE:
${knowledgeBase}

USER QUESTION: ${messages.text?.body || userMsg}`;

    let aiResponse = '';
    let parsedData = null;
    try {
      const rawResponse = await generateWithGemini(geminiKey, prompt);

      // Clean up mapping if it wrapped in markdown
      const cleanedResponse = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      parsedData = JSON.parse(cleanedResponse);
      aiResponse = parsedData.answer || '';

      if (parsedData.next_action === 'answer_faq') {
        if (aiResponse && !aiResponse.toLowerCase().includes('need anything else')) {
          aiResponse += '\n\nNeed anything else I can help you with?';
        }
      }
    } catch (err) {
      console.error('Gemini JSON parsing error:', err);
      aiResponse = "I'm having trouble accessing information right now. Please try again, or use the buttons below.";
      parsedData = { next_action: 'answer_faq' };
    }

    // Process the Action
    if (parsedData.next_action === 'trigger_flow') {
      await sendWhatsAppFlow({ ...helperParams, to: from, body: "Let's finish getting your details! Tap below to open our booking flow." });
      session.step = 'flow_in_progress';
      res.status(200).end();
      return;
    } else if (parsedData.next_action === 'skip_to_booking') {
      // PHASE 4: Verification Bridge
      const { service, date, time, customer_name } = parsedData;
      const calendars = { ...stylistCalendars, ...(config.calendars || {}) };

      // Verify slot using existing logic
      const result = await fetchRealTimeSlots(date, 0, 'subhashbhai', calendars);
      const isAvailable = result.slots.some(s => s.id === time || s.title === time);

      if (!isAvailable) {
        await sendWhatsAppFlow({ ...helperParams, to: from, body: `Sorry! The slot for *${time}* on *${date}* just got booked! Please select a new time below ⬇️` });
        session.step = 'flow_in_progress';
        res.status(200).end();
        return;
      } else {
        // Build final appointment object directly
        const appointmentData = {
          clientId,
          phone: from,
          name: customer_name,
          service,
          date,
          time,
          doctor: 'subhashbhai',
          status: 'confirmed',
          createdAt: new Date(),
          source: 'chatbot'
        };

        await Appointment.create(appointmentData);

        // Sync with Google Calendar
        const calendarId = calendars['subhashbhai'];
        const startTime = DateTime.fromFormat(`${date} ${time}`, 'dd/MM/yyyy h:mm a', { zone: 'Asia/Kolkata' }).toISO();
        const endTime = DateTime.fromISO(startTime).plus({ minutes: 60 }).toISO();

        const eventDetails = {
          summary: `Appointment: ${customer_name}`,
          description: `Service: ${service}\nPhone: ${from}`,
          startTime,
          endTime,
        };
        await createEvent(calendarId, eventDetails);

        await sendWhatsAppText({
          ...helperParams,
          to: from,
          body: `✨ *Legendary Choice!* ✨\n\nI've confirmed your booking!\n\n✅ *Final Booking Details*\n👤 *Name:* ${customer_name}\n📅 *Date:* ${date}\n🕒 *Time:* ${time}\n💇‍♀️ *Stylist:* subhashbhai\n💅 *Service:* ${service}\n\nWe will be ready for you. See you soon! 💅`
        });

        // Trigger Upsell
        await sendWhatsAppButtons({
          ...helperParams,
          to: from,
          imageHeader: SALON_IMG,
          body: `💅 *Confirm Your Luxury Upgrade* ✨\n\nUpgrade your booking with *Mirror Shine Botosmooth* for just ₹4000 extra!\nIt's our absolute best treatment for a glass-like finish! 💎✨`,
          footer: 'You want to upgrade? 👇',
          buttons: [
            { id: 'upsell_confirm_mirror_shine', title: 'Yes, Upgrade ✅' },
            { id: 'upsell_reject_mirror_shine', title: 'No, Thanks ❌' }
          ]
        });

        session.step = 'home';
        res.status(200).end();
        return;
      }
    } else {
      // Standard FAQ Answer
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

const handleFlowWebhook = async (req, res) => {
  try {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

    // 1. Decrypt AES Key
    const privateKey = fs.readFileSync(path.join(process.cwd(), 'private.pem'), 'utf8');
    let aesKey = crypto.privateDecrypt({
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    }, Buffer.from(encrypted_aes_key, 'base64'));

    if (aesKey.length !== 32) {
      console.warn(`[Choice Salon] Warning: Decrypted AES Key length is ${aesKey.length} bytes. Enforcing 32 bytes.`);
      const fixedKey = Buffer.alloc(32);
      aesKey.copy(fixedKey, 0, 0, Math.min(aesKey.length, 32));
      aesKey = fixedKey;
    }

    // 2. Decrypt Flow Data
    const iv = Buffer.from(initial_vector, 'base64');
    const flowDataBuffer = Buffer.from(encrypted_flow_data, 'base64');
    const authTagLength = 16;
    const authTag = flowDataBuffer.slice(flowDataBuffer.length - authTagLength);
    const ciphertext = flowDataBuffer.slice(0, flowDataBuffer.length - authTagLength);

    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    const decryptedBody = JSON.parse(decrypted);

    console.log('[Choice Salon] FLOW Decrypted Payload:', decryptedBody);

    let responsePayload = {};

    // 3. Handle 'ping' Action
    if (decryptedBody.action === 'ping') {
      responsePayload = { data: { status: "ACTIVE" } };
    }
    // 4. Handle 'fetch_slots' Action
    else if (decryptedBody.action === 'fetch_slots') {
      const service = decryptedBody.data?.service || 'Haircut';
      const date = decryptedBody.data?.date;

      let formattedSlotsArray = [];
      if (date) {
        // Fetch real-time slots
        const { whatsappToken: token, geminiApiKey, config, clientId } = req.clientConfig;
        const calendars = { ...stylistCalendars, ...(config.calendars || {}) };
        const result = await fetchRealTimeSlots(date, 0, 'subhashbhai', calendars); // Default stylist Subhashbhai

        // Format slots identically to the standard buttons structure
        formattedSlotsArray = result.slots.map(s => ({
          id: s.id,       // "10:00_AM"
          title: s.title  // "10:00 AM"
        }));
      }

      responsePayload = {
        screen: "TIME_AND_DETAILS_SCREEN",
        data: {
          selected_service: service,
          selected_date: date,
          available_slots: formattedSlotsArray
        }
      };
    } else {
      responsePayload = { data: { status: "ERROR" } };
    }

    // Encrypt the response payload
    const flippedIv = Buffer.alloc(12);
    for (let i = 0; i < 12; i++) {
      flippedIv[i] = ~iv[i];
    }

    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, flippedIv);
    const encryptedPayload = Buffer.concat([
      cipher.update(JSON.stringify(responsePayload), 'utf8'),
      cipher.final(),
      cipher.getAuthTag()
    ]);

    res.send(encryptedPayload.toString('base64'));

  } catch (error) {
    console.error('[Choice Salon] Flow Endpoint Error:', error);
    res.status(500).send();
  }
};

exports.handleWebhook = handleWebhook;
exports.handleFlowWebhook = handleFlowWebhook;
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
