const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const Client = require('../../models/Client');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Appointment = require('../../models/Appointment');
const DailyStat = require('../../models/DailyStat');
const BirthdayUser = require('../../models/BirthdayUser');
const { DoctorScheduleOverride } = require('../../models/DoctorScheduleOverride');

const { getAvailableTimeSlots, createEvent, deleteEvent, findEventsByPhoneNumber } = require('../../utils/googleCalendar');
const { getAvailableDates } = require('../../utils/getAvailableDates');
const { getAvailableSlots } = require('../../utils/getAvailableSlots');

const SERVER_URL = process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com';

// --- ROUGH N TURF CONSTANTS ---
const TURF_LOGO = `${SERVER_URL}/public/images/turf_logo.jpeg`;
const EQUIPMENT_B_TEXT = 'Match Ball & Bibs ⚽';
const EQUIPMENT_B_PRICE = 300;
const REFEREE_TEXT = 'Certified Referee ⏱️';
const REFEREE_PRICE = 800;

const PEAK_HOURS = ['17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'];
const OFF_PEAK_PRICE = 1500;
const PEAK_PRICE = 3500;

// Load knowledge base for OpenAI
const knowledgeBasePath = path.join(__dirname, '..', '..', 'utils', 'knowledgeBase.txt');
let knowledgeBase = '';
try {
  knowledgeBase = fs.readFileSync(knowledgeBasePath, 'utf8');
} catch (e) {
  console.warn('Knowledge base file not found, continuing without it.');
}

// In-memory state store for user sessions
const userSessions = {};

function getUserSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = {
      step: 'home',
      data: {}
    };
  }
  return userSessions[userId];
}

// --- Helper Functions ---

async function saveAndEmitMessage({ phoneNumberId, to, body, type, io, clientId, direction = 'outgoing' }) {
  try {
    let conversation = await Conversation.findOne({ phone: to, clientId });
    if (!conversation) {
      conversation = await Conversation.create({ phone: to, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
    }

    const savedMessage = await Message.create({
      clientId,
      conversationId: conversation._id,
      from: direction === 'outgoing' ? 'bot' : to,
      to: direction === 'outgoing' ? to : 'bot',
      content: body,
      type,
      direction,
      status: 'sent'
    });

    conversation.lastMessage = body;
    conversation.lastMessageAt = new Date();
    await conversation.save();

    if (io) {
      io.to(`client_${clientId}`).emit('new_message', savedMessage);
      io.to(`client_${clientId}`).emit('conversation_update', conversation);
    }
  } catch (e) {
    console.error('DB/Socket Error:', e);
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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
    await saveAndEmitMessage({ phoneNumberId, to, body, type: 'text', io, clientId });
  } catch (err) {
    console.error('Error sending WhatsApp text:', err.response?.data || err.message);
  }
}

async function sendWhatsAppButtons({ phoneNumberId, to, header, imageHeader, body, footer, buttons, token, io, clientId }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: buttons.map(({ id, title }) => ({
          type: 'reply',
          reply: { id, title: title.substring(0, 20) }
        }))
      }
    }
  };
  if (header) {
    data.interactive.header = { type: 'text', text: header };
  } else if (imageHeader) {
    data.interactive.header = { type: 'image', image: { link: imageHeader } };
  }
  if (footer) {
    data.interactive.footer = { text: footer };
  }
  try {
    await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
    await saveAndEmitMessage({ phoneNumberId, to, body: `[Buttons] ${body}`, type: 'interactive', io, clientId });
  } catch (err) {
    console.error('Error sending WhatsApp buttons:', err.response?.data || err.message);
  }
}

async function sendWhatsAppList({ phoneNumberId, to, header, imageHeader, body, footer, button, rows, token, io, clientId }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  let safeRows = rows;
  if (rows.length > 10) {
    safeRows = rows.slice(0, 10);
  }
  const data = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: header ? { type: 'text', text: header.substring(0, 60) } : undefined,
      body: { text: body },
      footer: footer ? { text: footer } : { text: '' },
      action: {
        button,
        sections: [
          {
            title: 'Options',
            rows: safeRows.map(r => {
              const row = { id: r.id, title: r.title };
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
    await saveAndEmitMessage({ phoneNumberId, to, body: `[List] ${body}`, type: 'interactive', io, clientId });
  } catch (err) {
    console.error('Error sending WhatsApp list:', err.response?.data || err.message);
  }
}

async function sendSmartButtonsOrList({ phoneNumberId, to, header, imageHeader, body, footer, buttons, fallbackButtonLabel = 'Select Option', token, io, clientId }) {
  if (buttons.length > 3) {
    await sendWhatsAppList({
      phoneNumberId,
      to,
      header,
      body,
      footer,
      button: fallbackButtonLabel,
      rows: buttons.map(({ id, title }) => ({ id, title })),
      token, io, clientId
    });
  } else {
    await sendWhatsAppButtons({
      phoneNumberId,
      to,
      header,
      imageHeader,
      body,
      footer,
      buttons,
      token, io, clientId
    });
  }
}

// --- WhatsApp Flow (Native Meta Form) ---
// Flow ID is stored in MongoDB: client.config.flowId
// Fallback chain: config.flowId → WHATSAPP_FLOW_ID env → hardcoded default

async function sendWhatsAppFlow({ phoneNumberId, to, flowId, token, io, clientId }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const data = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: { type: 'text', text: 'Rough N Turf ⚽' },
      body: { text: 'Please fill out your match details to check availability and book:' },
      footer: { text: 'Fast & secure booking' },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_action: 'navigate',
          flow_token: `turf_booking_${to}`,
          flow_id: flowId,
          flow_cta: '📅 Book Turf',
          flow_action_payload: {
            screen: 'BOOKING_SCREEN'
          }
        }
      }
    }
  };

  try {
    const resp = await axios.post(url, data, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    console.log('[TURF] Flow message sent:', resp.data);
    await saveAndEmitMessage({ phoneNumberId, to, body: '[Flow] Book your turf — tap to open form', type: 'interactive', io, clientId });
  } catch (err) {
    console.error('[TURF] Error sending WhatsApp Flow:', JSON.stringify(err.response?.data) || err.message);
  }
}

async function notifyAdmins({ phoneNumberId, message, token, adminNumbers, io, clientId }) {
  if (!adminNumbers || adminNumbers.length === 0) return;
  for (const adminNumber of adminNumbers) {
    await sendWhatsAppText({
      phoneNumberId,
      to: adminNumber,
      body: message,
      token, io, clientId
    });
  }
}

// --- Domain Logic ---

async function getAvailableBookingDays(doctor, calendars) {
  try {
    const calendarId = calendars[doctor];
    if (!calendarId) {
      return [];
    }
    const availableDates = await getAvailableDates(8, calendarId);
    return availableDates;
  } catch (error) {
    console.error('❌ Error getting available dates:', error);
    return [];
  }
}

async function fetchRealTimeSlots(dateStr, page = 0, doctor, calendars) {
  try {
    const calendarId = calendars[doctor];
    if (!calendarId) return { slots: [], totalSlots: 0, currentPage: 0, totalPages: 0, hasMore: false };

    // Fix Google Calendar Date Format parsing bug
    const reformattedDateStr = dateStr.includes('_') ? dateStr : dateStr;
    const result = await getAvailableSlots(reformattedDateStr, page, calendarId);
    return result;
  } catch (err) {
    console.error('Error fetching real time slots:', err);
    return { slots: [], totalSlots: 0, currentPage: 0, totalPages: 0, hasMore: false };
  }
}

const codeClinicServices = [
  { id: 'service_football', title: 'Football Booking (5v5)' },
  { id: 'service_football_large', title: 'Football Booking (8v8)' },
  { id: 'service_cricket', title: 'Box Cricket' },
  { id: 'service_pickleball', title: 'Pickleball Court' }
];

function getPaginatedServices(page = 0) {
  const servicesPerPage = 8;
  const startIndex = page * servicesPerPage;
  const endIndex = startIndex + servicesPerPage;
  const pageServices = codeClinicServices.slice(startIndex, endIndex);

  return {
    services: pageServices,
    currentPage: page,
    totalPages: Math.ceil(codeClinicServices.length / servicesPerPage),
    hasMore: endIndex < codeClinicServices.length
  };
}

const GREETING_WORDS = ['hi', 'hello', 'hey', 'hii', 'good morning', 'good afternoon', 'good evening', 'greetings', 'start', 'menu'];

// Helper to determine price based on slot time
function calculatePricing(time) {
  const isPeak = PEAK_HOURS.some(h => time.startsWith(h));
  return {
    price: isPeak ? PEAK_PRICE : OFF_PEAK_PRICE,
    label: isPeak ? 'Peak Hours 🌟' : 'Off-Peak Discount 📉'
  };
}

// --- Main Flow Handler ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, clientConfig, io }) {
  const session = getUserSession(from);
  const userMsgType = messages.type;
  const userMsg = userMsgType === 'interactive' ? (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id) : messages.text?.body;

  const { whatsappToken: token, openaiApiKey, config, clientId } = clientConfig;
  const calendars = config.calendars || {};
  const adminNumbers = config.adminPhones || (config.adminPhone ? [config.adminPhone] : []);
  // Resolve Flow ID: MongoDB config.flowId takes priority, then env, then hardcoded default
  const TURF_FLOW_ID = config.flowId || process.env.WHATSAPP_FLOW_ID || '2043223316539716';

  const genAI = new GoogleGenerativeAI(openaiApiKey || process.env.GEMINI_API_KEY);

  // ===================================================================
  // HANDLE WHATSAPP FLOW RESPONSE (nfm_reply)
  // Fires when the user clicks "Confirm Details" inside the native form.
  // Meta sends type=interactive, interactive.type="nfm_reply".
  // ===================================================================
  if (userMsgType === 'interactive' && messages.interactive?.type === 'nfm_reply') {
    try {
      const rawJson = messages.interactive.nfm_reply?.response_json;
      if (!rawJson) {
        console.warn('[TURF] nfm_reply received but response_json is empty');
        return res.status(200).end();
      }

      // Parse the JSON string Meta sends back from the Flow form
      const flowData = JSON.parse(rawJson);
      console.log('[TURF FLOW RESPONSE] Parsed payload:', JSON.stringify(flowData, null, 2));

      // Extract the 5 exact field names as defined in the Flow Builder
      const sport = flowData.sport || 'Turf Booking';
      const turf_arena = flowData.turf_arena || Object.keys(calendars)[0] || 'Standard';
      const date = flowData.date || 'TBD';
      const time = flowData.time || 'TBD';
      const captain_name = flowData.captain_name || 'Captain';

      // Normalise sport display name
      const serviceMap = {
        'football (5v5)': 'Football Booking (5v5)',
        'football (8v8)': 'Football Booking (8v8)',
        'box cricket': 'Box Cricket',
        'pickleball': 'Pickleball Court'
      };
      const chosenService = serviceMap[sport.toLowerCase()] || sport;

      // Save all 5 fields to session
      session.data.chosenService = chosenService;
      session.data.doctor = turf_arena;
      session.data.dateStr = date;
      session.data.date = date;
      session.data.time = time;
      session.data.name = captain_name;
      session.data.revenue = calculatePricing(time).price;
      session.step = 'appt_consent';

      // Jump straight to Step 6 — Confirmation screen
      await sendWhatsAppButtons({
        phoneNumberId, to: from, token, io, clientId,
        imageHeader: TURF_LOGO,
        body: `🥅 *Confirm Your Booking Details* 🥅\n\nReview your turf reservation:\n\n👤 *Captain Name:* ${captain_name}\n⚽ *Sport:* ${chosenService}\n🏟️ *Arena:* ${turf_arena}\n📅 *Date:* ${date}\n🕒 *Time:* ${time}\n\n💳 *Estimated Pitch Fee:* ₹${session.data.revenue} (Dynamic Pricing applied)\n\n_Do you want to confirm this reservation?_`,
        buttons: [
          { id: 'confirm_booking', title: 'Confirm Booking ✅' },
          { id: 'cancel_booking', title: 'Cancel ❌' }
        ]
      });
    } catch (err) {
      console.error('[TURF] Flow nfm_reply parse error:', err);
      await sendWhatsAppText({
        phoneNumberId, to: from, token, io, clientId,
        body: '⚠️ We had trouble reading your booking form. Please try again or type "menu".'
      });
    }
    return res.status(200).end();
  }

  // Handle STOP/UNSUBSCRIBE
  if (userMsgType === 'text' && userMsg && (userMsg.trim().toLowerCase() === 'stop' || userMsg.trim().toLowerCase() === 'unsubscribe')) {
    await sendWhatsAppText({ phoneNumberId, to: from, body: 'You have been unsubscribed.', token, io, clientId });
    delete userSessions[from];
    return res.status(200).end();
  }

  // Handle Upsells (Interactive execution)
  if (userMsg === 'upsell_equip_add' || userMsg === 'upsell_ref_add') {
    try {
      const lastAppt = await Appointment.findOne({ phone: from, clientId }).sort({ createdAt: -1 });
      if (lastAppt) {
        const isEquip = userMsg === 'upsell_equip_add';
        const addOnText = isEquip ? EQUIPMENT_B_TEXT : REFEREE_TEXT;
        const addOnPrice = isEquip ? EQUIPMENT_B_PRICE : REFEREE_PRICE;

        if (!lastAppt.service.includes(addOnText)) {
          lastAppt.service += ` + ${addOnText}`;
          lastAppt.revenue += addOnPrice;
          await lastAppt.save();

          await sendWhatsAppButtons({
            phoneNumberId, to: from, token, io, clientId,
            imageHeader: TURF_LOGO,
            body: `⚽ *Rough N Turf Add-on Confirmed!* ⚽\n\nWe've successfully added the *${addOnText.replace(' ⚽', '').replace(' ⏱️', '')}* to your booking.\n\n✅ *Final Booking Summary*\n👤 *Captain:* ${lastAppt.name}\n📅 *Date:* ${lastAppt.date}\n🕒 *Time:* ${lastAppt.time}\n🏟️ *Turf:* ${lastAppt.doctor || 'Standard'}\n⚽ *Package:* ${lastAppt.service}\n💰 *Total Due:* ₹${lastAppt.revenue}\n\nCan't wait to see you on the pitch! 🏆👇`,
            footer: 'Click below to share details with your squad!',
            buttons: [
              { id: 'action_share_squad', title: 'Share with Squad 📲' },
              { id: 'user_home', title: '🏠 Main Menu' }
            ]
          });

          await notifyAdmins({
            phoneNumberId, token, adminNumbers, io, clientId,
            message: `⚽ *Squad Upgraded!* ⚽\n\n${lastAppt.name} just added ${addOnText} to their booking!\n\n📅 ${lastAppt.date} @ ${lastAppt.time}\n🏟️ ${lastAppt.doctor}\n💰 *New Total:* ₹${lastAppt.revenue}`
          });
        }
        res.status(200).end();
        return;
      }
    } catch (err) { console.error('Upsell error:', err); }
  }

  if (userMsg === 'upsell_reject') {
    const lastAppt = await Appointment.findOne({ phone: from, clientId }).sort({ createdAt: -1 });
    await sendWhatsAppButtons({
      phoneNumberId, to: from, token, io, clientId,
      imageHeader: TURF_LOGO,
      body: `No problem at all! We've got your standard reservation locked in. ⚽⭐`,
      buttons: [
        { id: 'action_share_squad', title: 'Share with Squad 📲' },
        { id: 'user_home', title: '🏠 Main Menu' }
      ]
    });
    res.status(200).end();
    return;
  }

  if (userMsg === 'action_share_squad') {
    const lastAppt = await Appointment.findOne({ phone: from, clientId }).sort({ createdAt: -1 });
    if (lastAppt) {
      // Squad Split Calculator
      let formatStr = '5v5';
      let totalPlayers = 10;
      if (lastAppt.service.includes('8v8')) {
        totalPlayers = 16;
        formatStr = '8v8';
      } else if (lastAppt.service.includes('Pickleball')) {
        totalPlayers = 4;
        formatStr = 'Doubles';
      }
      const splitPrice = Math.round(lastAppt.revenue / totalPlayers);

      const shareMsg = `⚽ Match confirmed! ${lastAppt.doctor} at ${lastAppt.time}. Total ₹${lastAppt.revenue}. For a ${formatStr} format, it's just ₹${splitPrice} per person! Pay via UPI here...`;

      await sendWhatsAppText({ phoneNumberId, to: from, token, io, clientId, body: `Here is the squad detail message. Copy and paste this into your WhatsApp group! 👇` });
      await sendWhatsAppText({ phoneNumberId, to: from, token, io, clientId, body: shareMsg });
    }
    res.status(200).end();
    return;
  }

  // Greeting -> Main Menu
  if (userMsgType === 'text' && userMsg && GREETING_WORDS.some(w => userMsg.trim().toLowerCase().startsWith(w))) {
    await sendWhatsAppButtons({
      phoneNumberId,
      to: from,
      imageHeader: TURF_LOGO,
      body: '⚽ *Welcome to Rough N Turf!* 🏆\n\nI’m your virtual booking assistant. Ready for the next match? Choose an option below:',
      footer: 'Experience premium turf facilities at best prices!',
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Turf 🗓️' },
        { id: 'user_pricing', title: 'Pricing & Timings 💰' },
        { id: 'user_home', title: 'More Options ⚙️' }
      ],
      token, io, clientId
    });
    session.step = 'home_waiting';
    return res.status(200).end();
  }

  if (userMsg === 'user_home') {
    await sendWhatsAppList({
      phoneNumberId,
      to: from,
      header: 'Rough N Turf ⚽',
      body: 'Welcome to Rough N Turf! ⚽\n\nHere are all our options:',
      button: 'Menu',
      rows: [
        { id: 'user_schedule_appt', title: 'Book Turf 🗓️' },
        { id: 'user_cancel_appt', title: 'Cancel Booking ❌' },
        { id: 'user_pricing', title: 'Pricing Info 💰' },
        { id: 'user_ask_question', title: 'Ask a Question ❓' }
      ],
      token, io, clientId
    });
    session.step = 'home_waiting';
    return res.status(200).end();
  }

  if (userMsg === 'user_pricing') {
    await sendWhatsAppButtons({
      phoneNumberId, to: from, token, io, clientId,
      imageHeader: TURF_LOGO,
      body: `💰 *Rough N Turf Pricing Models*\n\nWe feature dynamic pricing to give you the best deals based on sunlight and peak traffic!\n\n📉 *Off-Peak Hours (10:00 AM - 4:00 PM)*\nRate: ₹${OFF_PEAK_PRICE} / hr\n\n🌟 *Prime Time Hours (5:00 PM - 11:00 PM & 6:00 AM - 9:00 AM)*\nRate: ₹${PEAK_PRICE} / hr\n\n_Note: Equipment and Refs are available as add-ons after booking._`,
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Now ⚽' },
        { id: 'user_home', title: 'Main Menu' }
      ]
    });
    res.status(200).end();
    return;
  }

  // ===================================================================
  // STEP 1 — SEND WHATSAPP FLOW (native form button)
  // Flow ID sourced from: MongoDB config.flowId → WHATSAPP_FLOW_ID env → fallback
  // ===================================================================
  if (userMsg === 'user_schedule_appt') {
    await sendWhatsAppFlow({ phoneNumberId, to: from, flowId: TURF_FLOW_ID, token, io, clientId });
    return res.status(200).end();
  }

  // Legacy fallback step handlers (only active if no flowId is set)
  if (session.step === 'choose_service' && userMsg && userMsg.startsWith('service_')) {
    const chosenServiceObj = codeClinicServices.find(s => s.id === userMsg) || { title: 'Turf Booking' };
    session.data.chosenService = chosenServiceObj.title;
    const doctorList = Object.keys(calendars).map(name => ({ id: `doctor_${name}`, title: name }));
    if (doctorList.length === 0) {
      await sendWhatsAppText({ phoneNumberId, to: from, body: 'No turfs available right now. Please call support.', token, io, clientId });
      return res.status(200).end();
    }
    await sendSmartButtonsOrList({ phoneNumberId, to: from, header: 'Select Turf Arena 🏟️', body: 'Please choose which turf you would like to book:', buttons: doctorList, token, io, clientId });
    session.step = 'choose_doctor';
    return res.status(200).end();
  }

  if (session.step === 'choose_doctor' && userMsg && userMsg.startsWith('doctor_')) {
    const doctorName = userMsg.replace('doctor_', '');
    session.data.doctor = doctorName;
    const days = await getAvailableBookingDays(doctorName, calendars);
    if (days.length === 0) { await sendWhatsAppText({ phoneNumberId, to: from, body: 'No dates available.', token, io, clientId }); return res.status(200).end(); }
    await sendWhatsAppList({ phoneNumberId, to: from, header: 'Match Date 📅', body: 'When is the squad playing? Select an available date:', button: 'Select Date', rows: days, token, io, clientId });
    session.step = 'appt_day';
    return res.status(200).end();
  }

  if (session.step === 'appt_day') {
    const days = await getAvailableBookingDays(session.data.doctor, calendars);
    const selectedDay = days.find(d => d.id === userMsg);
    if (selectedDay) {
      session.data.dateStr = selectedDay.title;
      let sanitizedDate = selectedDay.id;
      if (sanitizedDate.startsWith('calendar_day_')) {
        const d = new Date(selectedDay.title);
        sanitizedDate = !isNaN(d.getTime()) ? d.toISOString().split('T')[0] : DateTime.now().toFormat('yyyy-MM-dd');
      }
      session.data.date = sanitizedDate;
      const slots = await fetchRealTimeSlots(session.data.date, 0, session.data.doctor, calendars);
      if (slots.totalSlots === 0) { await sendWhatsAppText({ phoneNumberId, to: from, body: 'Sorry! All pitches are booked on this date. ⚠️', token, io, clientId }); return res.status(200).end(); }
      const rows = slots.slots.map(s => { const p = calculatePricing(s); return { id: `slot_${s}`, title: s, description: `₹${p.price}/hr - ${p.label}` }; });
      await sendWhatsAppList({ phoneNumberId, to: from, header: 'Kick-off Time ⏱️', body: 'Select a time slot. Dynamic pricing applies based on peak hours.', button: 'Select Time', rows, token, io, clientId });
      session.step = 'appt_time';
      return res.status(200).end();
    }
  }

  if (session.step === 'appt_time' && userMsg && userMsg.startsWith('slot_')) {
    session.data.time = userMsg.replace('slot_', '');
    session.data.revenue = calculatePricing(session.data.time).price;
    await sendWhatsAppText({ phoneNumberId, to: from, body: "Great! Lastly, type the *Captain's Name* for the booking:", token, io, clientId });
    session.step = 'appt_name';
    return res.status(200).end();
  }

  if (session.step === 'appt_name') {
    session.data.name = userMsg;
    await sendSmartButtonsOrList({
      phoneNumberId, to: from, imageHeader: TURF_LOGO,
      body: `🥅 *Confirm Your Booking Details* 🥅\n\n👤 *Captain:* ${session.data.name}\n⚽ *Sport:* ${session.data.chosenService}\n🏟️ *Arena:* ${session.data.doctor}\n📅 *Date:* ${session.data.dateStr || session.data.date}\n🕒 *Time:* ${session.data.time}\n💳 *Fee:* ₹${session.data.revenue}\n\n_Confirm your reservation?_`,
      buttons: [{ id: 'confirm_booking', title: 'Confirm Booking ✅' }, { id: 'cancel_booking', title: 'Cancel ❌' }],
      token, io, clientId
    });
    session.step = 'appt_consent';
    return res.status(200).end();
  }

  // Handle Consent/Confirmation & Upsell Trigger
  if (session.step === 'appt_consent') {
    if (userMsg === 'confirm_booking') {
      try {
        const revenue = session.data.revenue || 3500;

        // Create appointment in DB
        await Appointment.create({
          clientId,
          phone: from,
          name: session.data.name,
          service: session.data.chosenService,
          date: session.data.dateStr || session.data.date,
          time: session.data.time,
          status: 'confirmed',
          revenue: revenue,
          doctor: session.data.doctor
        });

        // Create event in Google Calendar for the selected turf
        try {
          const calendarId = calendars[session.data.doctor];
          if (calendarId) {
            // Build start datetime: combine date + time (date is YYYY-MM-DD, time is HH:MM)
            const [year, month, day] = (session.data.dateStr || session.data.date).split(/[-\/]/);
            const [hour, minute] = session.data.time.split(':');
            const startDateTime = new Date(year, month - 1, day, parseInt(hour), parseInt(minute || 0));
            const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // 1 hour slot

            await createEvent({
              calendarId,
              summary: `⚽ ${session.data.name} — ${session.data.chosenService}`,
              description: `Captain: ${session.data.name}\nPhone: ${from}\nSport: ${session.data.chosenService}\nArena: ${session.data.doctor}\nFee: ₹${revenue}`,
              startDateTime: startDateTime.toISOString(),
              endDateTime: endDateTime.toISOString(),
              attendeeEmail: null,
              phoneNumber: from
            });
            console.log(`[TURF] ✅ Google Calendar event created on calendar: ${calendarId}`);
          } else {
            console.warn(`[TURF] ⚠️ No calendarId found for turf: ${session.data.doctor}`);
          }
        } catch (calErr) {
          // Calendar error should NOT block the booking confirmation
          console.error('[TURF] Google Calendar createEvent error:', calErr.message);
        }

        // Notify Admin
        await notifyAdmins({
          phoneNumberId,
          message: `🏆 *New Rough N Turf Booking*\n\n👤 *Captain:* ${session.data.name}\n📅 *Date:* ${session.data.dateStr || session.data.date}\n🕒 *Time:* ${session.data.time}\n🏟️ *Arena:* ${session.data.doctor}\n💰 *Revenue:* ₹${revenue}`,
          token,
          adminNumbers, io, clientId
        });

        // Immediate Rough N Turf Upsell Trigger
        await sendWhatsAppButtons({
          phoneNumberId, to: from, token, io, clientId,
          imageHeader: TURF_LOGO,
          body: `✅ *Booking Secured!* We have reserved ${session.data.doctor} for you at ${session.data.time}.\n\nNeed a match ball and team bibs? Add for ₹300. Or need a certified Referee? Add for ₹800.`,
          buttons: [
            { id: 'upsell_equip_add', title: 'Ball & Bibs (+₹300)' },
            { id: 'upsell_ref_add', title: 'Referee (+₹800)' },
            { id: 'upsell_reject', title: 'No Thanks ❌' }
          ]
        });

      } catch (e) {
        console.error('Booking Error:', e);
        await sendWhatsAppText({ phoneNumberId, to: from, body: "⚠️ Error confirming booking. Please contact support.", token, io, clientId });
      }

      delete userSessions[from];
      return res.status(200).end();
    } else if (userMsg === 'cancel_booking') {
      await sendWhatsAppText({ phoneNumberId, to: from, body: "Booking cancelled. Come back when you're ready to play! ⚽", token, io, clientId });
      delete userSessions[from];
      return res.status(200).end();
    }
  }

  if (userMsg === 'user_cancel_appt') {
    await sendWhatsAppText({ phoneNumberId, to: from, body: 'To cancel your booking securely, please login to your client app or call our reception directly. 📞', token, io, clientId });
    return res.status(200).end();
  }

  if (userMsg === 'user_ask_question') {
    await sendWhatsAppText({ phoneNumberId, to: from, body: 'Sure! You can ask me any question about the turf rules, allowed studs, or facility amenities.', token, io, clientId });
    return res.status(200).end();
  }

  if (userMsgType === 'text') {
    try {
      // Using gemini-2.0-flash (gemini-1.5-flash is deprecated and returns 404)
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

      const smartPrompt = `You are the energetic and helpful virtual booking assistant for "Rough N Turf", a premium sports turf facility in Ahmedabad. Your persona is sporty, friendly, and professional. You understand both English and "Gujinglish" (Gujarati written in English alphabet).

Your goal is to answer FAQs, extract booking details, and decide the exact next step the chatbot system should take.

You MUST ALWAYS respond in strict JSON format. Never output plain text outside of the JSON structure.

### Business Knowledge & Pricing:
- Off-Peak (10:00 AM – 4:00 PM): ₹1,500/hr
- Peak (5:00 PM – 11:00 PM & 6:00 AM – 9:00 AM): ₹3,500/hr
- Sports: Football (5v5), Football (8v8), Box Cricket, Pickleball.
- Add-ons: Match Ball & Bibs (₹300), Certified Referee (₹800).

### Extraction Rules:
Extract these if mentioned:
1. "sport"
2. "turf_arena"
3. "date"
4. "time"
5. "captain_name"

### Next Action Routing Logic (CRITICAL):
You must evaluate the conversation and assign ONE of these strict values to the "next_action" field:
- "answer_question": The user is just asking a question (e.g., "What is the price?"). You answer it in the reply_message.
- "trigger_whatsapp_flow": The user wants to book, OR they provided *some* booking details, but NOT ALL 5 details. You must tell the system to show the form so they can fill in the rest.
- "skip_to_confirmation": The user provided ALL 5 booking details in their message (Zero-Click booking).
- "handover_to_admin": The user is angry, confused, or asks to speak to a human/call.

### JSON Output Structure:
{
  "reply_message": "Your conversational response to the user.",
  "extracted_data": {
    "sport": null,
    "turf_arena": null,
    "date": null,
    "time": null,
    "captain_name": null
  },
  "next_action": "answer_question | trigger_whatsapp_flow | skip_to_confirmation | handover_to_admin"
}

### Examples:

User: "Hi, booking karvu che"
Output:
{
  "reply_message": "⚽ Welcome to Rough N Turf! 🏆 Ready for the next match? Click the button below to book your turf.",
  "extracted_data": { "sport": null, "turf_arena": null, "date": null, "time": null, "captain_name": null },
  "next_action": "trigger_whatsapp_flow"
}

User: "Bhai aaje ratre su rate che?"
Output:
{
  "reply_message": "Aaje ratre (Prime Time) no rate ₹3,500/hr che. Do you want to check availability and book?",
  "extracted_data": { "sport": null, "turf_arena": null, "date": null, "time": null, "captain_name": null },
  "next_action": "trigger_whatsapp_flow"
}

User: "Book football 5v5 on Turf A for tomorrow 7am. Captain Yash."
Output:
{
  "reply_message": "Awesome Yash! Setting up your 5v5 Football match for tomorrow at 7 AM.",
  "extracted_data": { "sport": "Football (5v5)", "turf_arena": "Turf A", "date": "tomorrow", "time": "7:00 AM", "captain_name": "Yash" },
  "next_action": "skip_to_confirmation"
}

Now respond to this user message:
User: "${userMsg}"
Output:`;

      const result = await model.generateContent(smartPrompt);
      let rawReply = result.response.text().trim();

      // Strip markdown code fences if present
      rawReply = rawReply.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

      let aiResponse;
      try {
        aiResponse = JSON.parse(rawReply);
      } catch (parseErr) {
        console.error('Gemini JSON parse error, falling back to plain reply:', parseErr);
        await sendWhatsAppButtons({
          phoneNumberId, to: from, token, io, clientId,
          body: rawReply || "I'm not sure about that. Let me help you book!",
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Turf ⚽' },
            { id: 'user_home', title: 'Main Menu 🏠' }
          ]
        });
        return res.status(200).end();
      }

      const replyMsg = aiResponse.reply_message || "How can I help you today?";
      const extracted = aiResponse.extracted_data || {};
      const nextAction = aiResponse.next_action;

      // --- ROUTING BASED ON next_action ---

      if (nextAction === 'handover_to_admin') {
        // Notify admin and inform user
        await notifyAdmins({
          phoneNumberId, token, adminNumbers, io, clientId,
          message: `🚨 *Human Handover Requested*\n\n📞 Customer: ${from}\n💬 Message: "${userMsg}"\n\n_Please reach out to them directly._`
        });
        await sendWhatsAppButtons({
          phoneNumberId, to: from, token, io, clientId,
          imageHeader: TURF_LOGO,
          body: `${replyMsg}\n\n_Our team has been notified and will contact you shortly._ 📞`,
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Turf ⚽' },
            { id: 'user_home', title: 'Main Menu 🏠' }
          ]
        });
        return res.status(200).end();
      }

      if (nextAction === 'skip_to_confirmation') {
        // Pre-fill session with all extracted details and jump to confirmation
        const serviceMap = {
          'football (5v5)': 'Football Booking (5v5)',
          'football (8v8)': 'Football Booking (8v8)',
          'box cricket': 'Box Cricket',
          'pickleball': 'Pickleball Court'
        };
        const normalizedSport = extracted.sport ? (serviceMap[extracted.sport.toLowerCase()] || extracted.sport) : 'Turf Booking';

        session.data.chosenService = normalizedSport;
        session.data.doctor = extracted.turf_arena || Object.keys(calendars)[0] || 'Standard';
        session.data.dateStr = extracted.date || 'TBD';
        session.data.date = extracted.date || 'TBD';
        session.data.time = extracted.time || 'TBD';
        session.data.name = extracted.captain_name || 'Captain';

        // Calculate revenue based on extracted time
        const timeForPricing = extracted.time ? extracted.time.replace(':00 AM', ':00').replace(':00 PM', ':00') : '17:00';
        const pricingResult = calculatePricing(timeForPricing);
        session.data.revenue = pricingResult.price;

        session.step = 'appt_consent';

        await sendWhatsAppButtons({
          phoneNumberId, to: from, token, io, clientId,
          imageHeader: TURF_LOGO,
          body: `${replyMsg}\n\n🥅 *Quick Booking Summary* 🥅\n\n👤 *Captain:* ${session.data.name}\n⚽ *Sport:* ${session.data.chosenService}\n🏟️ *Arena:* ${session.data.doctor}\n📅 *Date:* ${session.data.dateStr}\n🕒 *Time:* ${session.data.time}\n💳 *Estimated Fee:* ₹${session.data.revenue}\n\n_Confirm your reservation below!_`,
          buttons: [
            { id: 'confirm_booking', title: 'Confirm Booking ✅' },
            { id: 'cancel_booking', title: 'Cancel ❌' }
          ]
        });
        return res.status(200).end();
      }

      if (nextAction === 'trigger_whatsapp_flow') {
        // Pre-fill any partially extracted data into session
        if (extracted.sport) {
          const serviceMap = {
            'football (5v5)': 'Football Booking (5v5)',
            'football (8v8)': 'Football Booking (8v8)',
            'box cricket': 'Box Cricket',
            'pickleball': 'Pickleball Court'
          };
          session.data.chosenService = serviceMap[extracted.sport.toLowerCase()] || extracted.sport;
        }
        if (extracted.turf_arena) session.data.doctor = extracted.turf_arena;
        if (extracted.date) session.data.dateStr = extracted.date;
        if (extracted.time) session.data.time = extracted.time;
        if (extracted.captain_name) session.data.name = extracted.captain_name;

        // Send AI reply text first
        await sendWhatsAppText({ phoneNumberId, to: from, body: replyMsg, token, io, clientId });

        // 🚀 Send the WhatsApp Flow form (Flow ID from MongoDB config.flowId)
        await sendWhatsAppFlow({ phoneNumberId, to: from, flowId: TURF_FLOW_ID, token, io, clientId });
        return res.status(200).end();
      }

      // Default: answer_question — just send the reply with CTA buttons
      await sendWhatsAppButtons({
        phoneNumberId, to: from, token, io, clientId,
        body: replyMsg,
        buttons: [
          { id: 'user_schedule_appt', title: 'Book Turf ⚽' },
          { id: 'user_home', title: 'Main Menu 🏠' }
        ]
      });

    } catch (e) {
      console.error('Gemini Smart Handler Error:', e);
      await sendWhatsAppText({ phoneNumberId, to: from, body: "I'm sorry, I didn't understand that. Type 'menu' to see options.", token, io, clientId });
    }
  }

  return res.status(200).end();
}

// --- Exported Webhook Handler ---

exports.handleWebhook = async (req, res) => {
  try {
    // DEBUG: Log the entire incoming payload to see why it's silently failing
    console.log(`[TURF WEBHOOK RAW PAYLOAD]:`, JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = value?.messages?.[0];
    if (!messages) {
      console.log('[TURF WEBHOOK] No messages array found in payload. Returning 200.');
      return res.status(200).end();
    }

    const io = req.app.get('socketio');
    const { whatsappToken, config, clientId, openaiApiKey } = req.clientConfig;
    const token = whatsappToken || process.env.WHATSAPP_TOKEN;

    const conversation = await Conversation.findOneAndUpdate(
      { phone: messages.from, clientId },
      { $set: { status: 'BOT_ACTIVE', lastMessageAt: new Date() } },
      { upsert: true, new: true }
    );

    const userMsgContent = messages.type === 'text' ? messages.text.body : `[${messages.type}]`;

    await Message.create({
      clientId,
      conversationId: conversation._id,
      from: messages.from,
      to: 'bot',
      content: userMsgContent,
      type: messages.type,
      direction: 'incoming',
      status: 'received',
      timestamp: new Date()
    });

    if (io) io.to(`client_${clientId}`).emit('new_message', {
      clientId,
      from: messages.from,
      content: userMsgContent,
      direction: 'incoming'
    });

    await handleUserChatbotFlow({ from: messages.from, phoneNumberId: value.metadata.phone_number_id, messages, res, clientConfig: req.clientConfig, io });

  } catch (err) {
    console.error('Webhook Error:', err.message);
    res.status(200).end();
  }
};

module.exports = router;
module.exports.handleWebhook = exports.handleWebhook;
