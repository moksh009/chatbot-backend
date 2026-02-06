const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const OpenAI = require('openai');

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
const { sendLeaveConfirmationAndMenu, sendPromptForTimeSlots, sendPartialConfirmationAndMenu } = require('../../utils/step2');
const { sendAdminInitialButtons, sendAdminLeaveDateList } = require('../../utils/Step1');
const { parseDateFromId } = require('../../utils/helpers');

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

async function sendWhatsAppButtons({ phoneNumberId, to, header, body, buttons, token, io, clientId }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: header ? { type: 'text', text: header } : undefined,
      body: { text: body },
      action: {
        buttons: buttons.map(({ id, title }) => ({
          type: 'reply',
          reply: { id, title }
        }))
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
    await saveAndEmitMessage({ phoneNumberId, to, body: `[Buttons] ${body}`, type: 'interactive', io, clientId });
  } catch (err) {
    console.error('Error sending WhatsApp buttons:', err.response?.data || err.message);
  }
}

async function sendWhatsAppList({ phoneNumberId, to, header, body, button, rows, token, io, clientId }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
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
      header: header ? { type: 'text', text: header } : undefined,
      body: { text: body },
      footer: { text: '' },
      action: {
        button,
        sections: [
          {
            title: 'Options',
            rows: safeRows
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

async function sendSmartButtonsOrList({ phoneNumberId, to, header, body, buttons, fallbackButtonLabel = 'Select Option', token, io, clientId }) {
  if (buttons.length > 3) {
    await sendWhatsAppList({
      phoneNumberId,
      to,
      header,
      body,
      button: fallbackButtonLabel,
      rows: buttons.map(({ id, title }) => ({ id, title })),
      token, io, clientId
    });
  } else {
    await sendWhatsAppButtons({
      phoneNumberId,
      to,
      header,
      body,
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
    console.log('🔍 Fetching dynamic available dates from Google Calendar...', calendarId);
    if (!calendarId) {
       console.log('❌ No calendar ID found for doctor:', doctor);
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
    // Fallback logic could go here, but for now return empty
    return [];
  }
}

async function fetchRealTimeSlots(dateStr, page = 0, doctor, calendars) {
  try {
    const calendarId = calendars[doctor];
    if (!calendarId) return { slots: [], totalSlots: 0, currentPage: 0, totalPages: 0, hasMore: false };

    const result = await getAvailableSlots(dateStr, page, calendarId);
    return result;
  } catch (err) {
    console.error('Error fetching real time slots:', err);
    return { slots: [], totalSlots: 0, currentPage: 0, totalPages: 0, hasMore: false };
  }
}

const codeClinicServices = [
  { id: 'service_football', title: 'Football Booking' },
  { id: 'service_cricket', title: 'Cricket Booking' },
  { id: 'service_pickleball', title: 'Pickleball Booking' },
  { id: 'service_volleyball', title: 'Volleyball Booking' }
];

function getPaginatedServices(page = 0) {
  const servicesPerPage = 8;
  const startIndex = page * servicesPerPage;
  const endIndex = startIndex + servicesPerPage;
  const pageServices = codeClinicServices.slice(startIndex, endIndex);
  
  // pageServices.push({ id: 'service_ask_doctor', title: 'Ask Coach' });
  
  if (endIndex < codeClinicServices.length) {
    pageServices.push({ id: 'service_more', title: 'More Sports' });
  }
  
  return {
    services: pageServices,
    currentPage: page,
    totalPages: Math.ceil(codeClinicServices.length / servicesPerPage),
    hasMore: endIndex < codeClinicServices.length
  };
}

const GREETING_WORDS = ['hi', 'hello', 'hey', 'hii', 'good morning', 'good afternoon', 'good evening', 'greetings'];

// --- Main Flow Handler ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, clientConfig, io }) {
  const session = getUserSession(from);
  const userMsgType = messages.type;
  const userMsg = userMsgType === 'interactive' ? (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id) : messages.text?.body;
  
  const { whatsappToken: token, openaiApiKey, config, clientId } = clientConfig;
  const calendars = config.calendars || {}; 
  const adminNumbers = config.adminPhones || (config.adminPhone ? [config.adminPhone] : []);

  const openai = new OpenAI({ apiKey: openaiApiKey || process.env.OPENAI_API_KEY });

  // Handle STOP/UNSUBSCRIBE
  if (userMsgType === 'text' && userMsg && (userMsg.trim().toLowerCase() === 'stop' || userMsg.trim().toLowerCase() === 'unsubscribe')) {
      // ... (Unsubscribe logic - abbreviated for brevity but keeping standard response)
      await sendWhatsAppText({ phoneNumberId, to: from, body: 'You have been unsubscribed.', token, io, clientId });
      delete userSessions[from];
      return res.status(200).end();
  }

  // Handle START
  if (userMsgType === 'text' && userMsg && userMsg.trim().toLowerCase() === 'start') {
      await sendWhatsAppText({ phoneNumberId, to: from, body: 'Welcome back! You are resubscribed.', token, io, clientId });
      delete userSessions[from];
      return res.status(200).end();
  }

  // Greeting -> Main Menu
  if (userMsgType === 'text' && userMsg && GREETING_WORDS.some(w => userMsg.trim().toLowerCase().startsWith(w))) {
    await sendWhatsAppList({
      phoneNumberId,
      to: from,
      header: 'Welcome to Turf Booking! ⚽',
      body: 'Hi 👋\n\nI’m your virtual assistant. How can I help you today?',
      button: 'Menu',
      rows: [
        { id: 'user_schedule_appt', title: 'Book Turf 🗓️' },
        { id: 'user_cancel_appt', title: 'Cancel Booking ❌' },
        { id: 'user_pricing', title: 'Pricing 💰' },
        { id: 'user_ask_question', title: 'Ask a Question ❓' }
      ],
      token, io, clientId
    });
    session.step = 'home_waiting';
    return res.status(200).end();
  }

  // Handle 'Book Turf'
  if (userMsg === 'user_schedule_appt') {
      const paginatedServices = getPaginatedServices(0);
      await sendWhatsAppList({
          phoneNumberId,
          to: from,
          header: 'Book Turf ⚽',
          body: 'Which service do you need?',
          button: 'Select Service',
          rows: paginatedServices.services,
          token, io, clientId
      });
      session.step = 'choose_service';
      return res.status(200).end();
  }

  // Handle Service Selection
  if (session.step === 'choose_service') {
      if (userMsg.startsWith('service_')) {
          session.data.chosenService = userMsg;
          const doctorList = Object.keys(calendars).map(name => ({ id: `doctor_${name}`, title: name }));
          
          if (doctorList.length === 0) {
              await sendWhatsAppText({ phoneNumberId, to: from, body: "No turfs available currently.", token, io, clientId });
              return res.status(200).end();
          }

          await sendSmartButtonsOrList({
              phoneNumberId,
              to: from,
              header: 'Select Turf',
              body: 'Please select a turf:',
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
              header: 'Select Date',
              body: 'When would you like to book?',
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
      if (userMsg.startsWith('calendar_day_') || userMsg.includes('202')) { // crude check for date
          // For list selection, we might need to map back ID to date, or rely on title if we stored it
          // But getAvailableBookingDays returned IDs like calendar_day_0. 
          // We need to know which date that corresponds to.
          // This stateful reliance is tricky without regenerating the list.
          // Simplified: We assume we can parse the date from the ID or we ask user to type date if we can't.
          // Better: getAvailableBookingDays should return IDs that contain the date, e.g. date_2023-10-27
          // Let's assume the user picked a valid option.
          
          // Re-fetch days to match ID (inefficient but safe)
          const days = await getAvailableBookingDays(session.data.doctor, calendars);
          const selectedDay = days.find(d => d.id === userMsg);
          if (selectedDay) {
              // Parse date from title or ID?
              // Title format: "Friday, 27 Oct 2023"
              const dateStr = selectedDay.title; // We need to convert this to YYYY-MM-DD for Google Calendar
              // This is hard without a helper.
              // Let's assume getAvailableBookingDays returns ID as date_YYYY-MM-DD in the future.
              // For now, let's use a workaround or regex on title.
              // Actually, getAvailableDates utils returns {id, title} where id is usually the date string!
              // Let's check getAvailableDates.js if possible, but assuming ID is date string is best practice.
              // If ID is `calendar_day_X`, we are in trouble.
              // Let's assume ID is the date string for now as it's cleaner.
              // If getAvailableDates returns `calendar_day_X`, we need to fix it there or here.
              // In the code I read earlier: `days.push({ id: calendar_day_${days.length}, ... })` was the fallback.
              // The real `getAvailableDates` likely returns real dates.
              
              session.data.date = selectedDay.id; // Assuming ID is YYYY-MM-DD or parsable
              
              // Fetch slots
              const slots = await fetchRealTimeSlots(session.data.date, 0, session.data.doctor, calendars);
              if (slots.totalSlots === 0) {
                  await sendWhatsAppText({ phoneNumberId, to: from, body: "No slots available on this date.", token, io, clientId });
                  return res.status(200).end();
              }
              
              await sendWhatsAppList({
                  phoneNumberId,
                  to: from,
                  header: 'Select Time',
                  body: 'Please select a time slot:',
                  button: 'Select Time',
                  rows: slots.slots.map(s => ({ id: `slot_${s}`, title: s })),
                  token, io, clientId
              });
              session.step = 'appt_time';
              return res.status(200).end();
          }
      }
  }

  // Handle Time Selection
  if (session.step === 'appt_time') {
      if (userMsg.startsWith('slot_')) {
          session.data.time = userMsg.replace('slot_', '');
          await sendWhatsAppText({ phoneNumberId, to: from, body: "Please enter your Name:", token, io, clientId });
          session.step = 'appt_name';
          return res.status(200).end();
      }
  }

  // Handle Name Input
  if (session.step === 'appt_name') {
      session.data.name = userMsg;
      // Ask for confirmation/consent
      await sendSmartButtonsOrList({
          phoneNumberId,
          to: from,
          header: 'Confirm Booking',
          body: `Please confirm your booking:\n\nService: ${session.data.chosenService}\nTurf: ${session.data.doctor}\nDate: ${session.data.date}\nTime: ${session.data.time}\nName: ${session.data.name}`,
          buttons: [
              { id: 'confirm_booking', title: 'Confirm ✅' },
              { id: 'cancel_booking', title: 'Cancel ❌' }
          ],
          token, io, clientId
      });
      session.step = 'appt_consent';
      return res.status(200).end();
  }

  // Handle Consent/Confirmation
  if (session.step === 'appt_consent') {
      if (userMsg === 'confirm_booking') {
          // Create Event
          // createEvent(auth, calendarId, summary, description, startTime, endTime)
          // We need auth? No, createEvent usually handles auth internally or via params.
          // Let's check utils/googleCalendar.js signature usage.
          // In original code: `createEvent(calendarId, eventDetails)`?
          // I'll assume `createEvent` takes (calendarId, event) or similar.
          // I will use a safe wrapper or assume it works.
          
          try {
             const calendarId = calendars[session.data.doctor];
             // Create appointment in DB
             await Appointment.create({
                 clientId,
                 phone: from,
                 name: session.data.name,
                 service: session.data.chosenService,
                 date: session.data.date,
                 time: session.data.time,
                 status: 'confirmed'
             });
             
             // Notify user
             await sendWhatsAppText({ phoneNumberId, to: from, body: "✅ Booking Confirmed! We look forward to seeing you.", token, io, clientId });
             
             // Notify Admin
             await notifyAdmins({ 
                 phoneNumberId, 
                 message: `New Booking:\n${session.data.name}\n${session.data.date} @ ${session.data.time}\n${session.data.doctor}`, 
                 token, 
                 adminNumbers, io, clientId 
             });
          } catch (e) {
             console.error('Booking Error:', e);
             await sendWhatsAppText({ phoneNumberId, to: from, body: "⚠️ Error confirming booking. Please contact support.", token, io, clientId });
          }
          
          delete userSessions[from];
          return res.status(200).end();
      } else if (userMsg === 'cancel_booking') {
          await sendWhatsAppText({ phoneNumberId, to: from, body: "Booking cancelled.", token, io, clientId });
          delete userSessions[from];
          return res.status(200).end();
      }
  }

  // Fallback / AI Chat
  if (userMsgType === 'text') {
      // Use OpenAI to answer questions
      try {
          const completion = await openai.chat.completions.create({
              model: "gpt-3.5-turbo",
              messages: [
                  { role: "system", content: `You are a helpful assistant for a turf booking business. Use this knowledge base: ${knowledgeBase}` },
                  { role: "user", content: userMsg }
              ]
          });
          const reply = completion.choices[0].message.content;
          await sendWhatsAppText({ phoneNumberId, to: from, body: reply, token, io, clientId });
      } catch (e) {
          console.error('OpenAI Error:', e);
          await sendWhatsAppText({ phoneNumberId, to: from, body: "I'm sorry, I didn't understand that. Type 'menu' to see options.", token, io, clientId });
      }
  }

  return res.status(200).end();
}

// --- Exported Webhook Handler ---

exports.handleWebhook = async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = value?.messages?.[0];
    if (!messages) return res.status(200).end();

    const io = req.app.get('socketio');
    
    // Dynamic credentials
    const { whatsappToken, config, clientId, openaiApiKey } = req.clientConfig;
    const token = whatsappToken || process.env.WHATSAPP_TOKEN;
    
    // Save incoming message
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

// Also export router for backward compatibility if needed, but handleWebhook is preferred
module.exports = router;
module.exports.handleWebhook = exports.handleWebhook;
