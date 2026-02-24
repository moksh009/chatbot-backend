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

  const genAI = new GoogleGenerativeAI(openaiApiKey || process.env.GEMINI_API_KEY);

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

  // Handle 'Book Turf'
  if (userMsg === 'user_schedule_appt') {
    const paginatedServices = getPaginatedServices(0);
    await sendWhatsAppList({
      phoneNumberId,
      to: from,
      header: 'Rough N Turf 🏆',
      body: 'Choose Your Sport 🏆\n\nWe offer world-class pitches and courts. Which sport are you playing today?',
      button: 'Select Sport',
      rows: paginatedServices.services,
      token, io, clientId
    });
    session.step = 'choose_service';
    return res.status(200).end();
  }

  // Handle Service Selection
  if (session.step === 'choose_service') {
    if (userMsg.startsWith('service_')) {
      const chosenServiceObj = codeClinicServices.find(s => s.id === userMsg) || { title: 'Turf Booking' };
      session.data.chosenService = chosenServiceObj.title;

      const doctorList = Object.keys(calendars).map(name => ({ id: `doctor_${name}`, title: name }));

      if (doctorList.length === 0) {
        await sendWhatsAppText({ phoneNumberId, to: from, body: "No turfs available right now. Please call support.", token, io, clientId });
        return res.status(200).end();
      }

      await sendSmartButtonsOrList({
        phoneNumberId,
        to: from,
        header: 'Select Turf Arena 🏟️',
        body: 'Please choose which turf you would like to book:',
        buttons: doctorList,
        token, io, clientId
      });
      session.step = 'choose_doctor';
      return res.status(200).end();
    }
  }

  // Handle Turf Selection
  if (session.step === 'choose_doctor') {
    if (userMsg.startsWith('doctor_')) {
      const doctorName = userMsg.replace('doctor_', '');
      session.data.doctor = doctorName;

      const days = await getAvailableBookingDays(doctorName, calendars);
      if (days.length === 0) {
        await sendWhatsAppText({ phoneNumberId, to: from, body: "No dates available.", token, io, clientId });
        return res.status(200).end();
      }

      await sendWhatsAppList({
        phoneNumberId,
        to: from,
        header: 'Match Date 📅',
        body: 'When is the squad playing? Select an available date:',
        button: 'Select Date',
        rows: days,
        token, io, clientId
      });
      session.step = 'appt_day';
      return res.status(200).end();
    }
  }

  // Handle Date Selection
  if (session.step === 'appt_day') {
    const days = await getAvailableBookingDays(session.data.doctor, calendars);
    const selectedDay = days.find(d => d.id === userMsg);
    if (selectedDay) {
      session.data.dateStr = selectedDay.title; // store human readable

      // Critical FIX for Invalid Date Format: Ensure we get YYYY-MM-DD from the calendar ID string format 'calendar_day_X'
      let sanitizedDate = selectedDay.id;
      if (sanitizedDate.startsWith('calendar_day_')) {
        const d = new Date(selectedDay.title);
        if (!isNaN(d.getTime())) {
          sanitizedDate = d.toISOString().split('T')[0];
        } else {
          sanitizedDate = DateTime.now().toFormat('yyyy-MM-dd'); // safe fallback
        }
      }

      session.data.date = sanitizedDate;

      // Fetch slots using safe sanitized date
      const slots = await fetchRealTimeSlots(session.data.date, 0, session.data.doctor, calendars);
      if (slots.totalSlots === 0) {
        await sendWhatsAppText({ phoneNumberId, to: from, body: "Sorry! All pitches are booked on this date. ⚠️", token, io, clientId });
        return res.status(200).end();
      }

      const rows = slots.slots.map(s => {
        const pricing = calculatePricing(s);
        return {
          id: `slot_${s}`,
          title: s,
          description: `₹${pricing.price}/hr - ${pricing.label}`
        };
      });

      await sendWhatsAppList({
        phoneNumberId,
        to: from,
        header: 'Kick-off Time ⏱️',
        body: 'Select a time slot. Note: Dynamic pricing is applied based on peak hours.',
        button: 'Select Time',
        rows: rows,
        token, io, clientId
      });
      session.step = 'appt_time';
      return res.status(200).end();
    }
  }

  // Handle Time Selection
  if (session.step === 'appt_time') {
    if (userMsg.startsWith('slot_')) {
      session.data.time = userMsg.replace('slot_', '');

      // Calculate dynamic pricing and save it to session
      const pricing = calculatePricing(session.data.time);
      session.data.revenue = pricing.price;

      await sendWhatsAppText({ phoneNumberId, to: from, body: "Great! Lastly, please type the *Captain's Name* for the booking:", token, io, clientId });
      session.step = 'appt_name';
      return res.status(200).end();
    }
  }

  // Handle Name Input -> Show Dynamic Consent
  if (session.step === 'appt_name') {
    session.data.name = userMsg;

    await sendSmartButtonsOrList({
      phoneNumberId,
      to: from,
      imageHeader: TURF_LOGO,
      body: `🥅 *Confirm Your Booking Details* 🥅\n\nReview your turf reservation:\n\n👤 *Captain Name:* ${session.data.name}\n⚽ *Sport:* ${session.data.chosenService}\n🏟️ *Arena:* ${session.data.doctor}\n📅 *Date:* ${session.data.dateStr || session.data.date}\n🕒 *Time:* ${session.data.time}\n\n💳 *Estimated Pitch Fee:* ₹${session.data.revenue} (Dynamic Pricing applied)\n\n_Do you want to confirm this reservation?_`,
      buttons: [
        { id: 'confirm_booking', title: 'Confirm Booking ✅' },
        { id: 'cancel_booking', title: 'Cancel ❌' }
      ],
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
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const fullPrompt = `System: You are an assistant for Rough N Turf, a premium sports turf. Use professional, energetic tone. Answer this user: ${userMsg}`;
      const result = await model.generateContent(fullPrompt);
      const reply = result.response.text().trim();
      await sendWhatsAppButtons({
        phoneNumberId, to: from, token, io, clientId,
        body: reply,
        buttons: [
          { id: 'user_schedule_appt', title: 'Book Turf ⚽' },
          { id: 'user_home', title: 'Main Menu 🏠' }
        ]
      });
    } catch (e) {
      console.error('Gemini Error:', e);
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
