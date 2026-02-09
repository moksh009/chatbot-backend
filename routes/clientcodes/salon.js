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
const DailyStat = require('../../models/DailyStat');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const { DateTime } = require('luxon');
const OpenAI = require('openai');

// Detect greeting words
const GREETING_WORDS = ['hi', 'hello', 'hey', 'hii', 'good morning', 'good afternoon', 'good evening', 'greetings'];

// Add at the top for topic list
const QUESTION_TOPICS = [
  { id: 'ask_services', title: 'Services' },
  { id: 'ask_pricing', title: 'Pricing' },
  { id: 'ask_appointments', title: 'Booking' },
  { id: 'ask_other', title: 'Something else' }
];

const BirthdayUser = require('../../models/BirthdayUser');

// Load knowledge base for OpenAI
const knowledgeBase = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'knowledgeBase.txt'), 'utf8');

// In-memory state store for user sessions (for MVP; replace with Redis/DB for production)
const userSessions = {};

// Salon services
const salonServices = [
  { id: 'service_haircut', title: 'Haircut' },
  { id: 'service_spa', title: 'Spa' },
  { id: 'service_facial', title: 'Facial' },
  { id: 'service_massage', title: 'Massage' }
];

// Real stylists
const salonStylists = [
  { id: 'stylist_sarah', title: 'Stylist Sarah' },
  { id: 'stylist_mike', title: 'Stylist Mike' }
];

// Helper: get pricing info
const salonPricing = [
  { service: 'Haircut', price: '500' },
  { service: 'Spa', price: '1500' },
  { service: 'Facial', price: '1200' },
  { service: 'Massage', price: '2000' }
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

// Helper to send plain WhatsApp text message
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

    // Find conversation to attach message
    let conversation = await Conversation.findOne({ phone: to, clientId });
    if (!conversation) {
      conversation = await Conversation.create({ phone: to, clientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
    }

    // Update conversation
    conversation.lastMessage = body;
    conversation.lastMessageAt = new Date();
    await conversation.save();

    if (io) {
        io.to(`client_${clientId}`).emit('conversation_update', conversation);
    }

    // Save and emit message
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

// Helper to send WhatsApp interactive button message
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
async function sendWhatsAppList({ phoneNumberId, to, header, body, button, rows, token, io, clientId }) {
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
      header: header ? { type: 'text', text: header } : undefined,
      body: { text: body },
      footer: { text: '' },
      action: {
        button,
        sections: [
          {
            title: 'Available Days',
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
    const calendarId = calendars[stylist];
    console.log('🔍 Fetching dynamic available dates from Google Calendar...', calendarId);
    
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
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Kampala' }));
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
    const calendarId = calendars[stylist];
    console.log(`🔍 Fetching available slots for ${dateStr} (page ${page}) with stylist ${stylist}...`);
    
    if (!calendarId) {
        console.error(`No calendar ID configured for stylist: ${stylist}`);
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
  const { whatsappToken: token, openaiApiKey, config, clientId } = clientConfig;
  const calendars = config.calendars || {}; 
  const adminNumbers = config.adminPhones || (config.adminPhone ? [config.adminPhone] : []);
  const openai = new OpenAI({ apiKey: openaiApiKey || process.env.OPENAI_API_KEY });

  const session = getUserSession(from);
  const userMsgType = messages.type;
  const userMsg = userMsgType === 'interactive' ? (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id) : messages.text?.body;

  // Pass common params to helpers
  const helperParams = { phoneNumberId, token, io, clientId };

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
        phoneNumberId,
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
        phoneNumberId,
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
        phoneNumberId,
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
        phoneNumberId,
        to: from,
        body: '⚠️ We encountered an error processing your request. Please try again later or contact support.'
      });
      res.status(200).end();
      return;
    }
  }

  // If user sends a greeting, always show the main menu WhatsApp List
  if (userMsgType === 'text' && userMsg && GREETING_WORDS.some(w => userMsg.trim().toLowerCase().startsWith(w))) {
    await sendWhatsAppList({
      phoneNumberId,
      to: from,
      header: 'Welcome to Salon Appointment! 💇‍♀️',
      body: 'Hi 👋\n\nI’m moksh, your virtual assistant for Salon Appointment, ahmedabad. How can I help you today? Please select an option below:',
      button: 'Menu',
      rows: [
        { id: 'user_schedule_appt', title: 'Book Appointment 🗓️' },
        { id: 'user_cancel_appt', title: 'Cancel Appointment ❌' },
        { id: 'user_reschedule_appt', title: 'Reschedule Appointment 🔁' },
        { id: 'user_pricing', title: 'Pricing 💰' },
        { id: 'user_ask_question', title: 'Ask a Question ❓' }
      ]
    });
    session.step = 'home_waiting';
    res.status(200).end();
    return;
  }

      // AI-powered free-text handling (not a button/list reply)
  if (userMsgType === 'text' && (!session.step || session.step === 'home' || session.step === 'home_waiting' || session.step === 'faq_menu' || session.step === 'appt_day' || session.step === 'appt_pick_day_waiting' || session.step === 'appt_time_waiting' || session.step === 'ask_question_topic' || session.step === 'faq_await')) {
    
    // Check if user is explicitly trying to book an appointment via text
    const bookingKeywords = ['book appointment', 'make appointment', 'schedule appointment', 'book visit', 'see stylist', 'book salon session'];
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
        phoneNumberId,
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
    // Enhanced OpenAI prompt for precise, human-like responses
    const prompt = `You are moksh, a friendly salon appointment assistant for SALON APPOINTMENT in ahmedabad, Uganda.

IMPORTANT INSTRUCTIONS:
1. Use the knowledge base below to provide accurate, helpful information
2. Keep responses SHORT and PRECISE (max 2-3 sentences)
3. Be conversational and warm, but direct to the point
4. Use 1-2 relevant emojis maximum
4. If asked about software/technology: "We use modern booking software for salon management and scheduling."
5. If asked about pricing: Mention 2-3 top services only
6. If asked about hours: "We're open Monday-Sunday, 10 AM to 8 PM"
7. If question is NOT about salon services: Politely redirect to salon topics
8. If unsure: "I'd be happy to connect you with our team for specific questions"
9. End with a simple "Need anything else?" or "How can I help?"

KNOWLEDGE BASE:
${knowledgeBase}

USER QUESTION: ${userMsg}

Provide a SHORT, PRECISE response:`;
    
    let aiResponse = '';
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        temperature: 0.8,
        max_tokens: 500,
        messages: [
          { 
            role: 'system', 
            content: 'You are moksh, a friendly salon appointment assistant for Salon Appointment in ahmedabad. Be conversational, warm, and helpful. Use natural language, appropriate emojis, and always sound like a real person. Reference the knowledge base for accurate information.' 
          },
          { role: 'user', content: prompt }
        ]
      });
      aiResponse = completion.choices[0].message.content.trim();
      
      // Ensure the response ends with a friendly closing if it doesn't already
      if (!aiResponse.toLowerCase().includes('need anything else') && 
          !aiResponse.toLowerCase().includes('anything else') &&
          !aiResponse.toLowerCase().includes('help you') &&
          !aiResponse.toLowerCase().includes('assistance')) {
        aiResponse += '\n\nNeed anything else I can help you with? 😊';
      }
      
    } catch (err) {
      console.error('OpenAI API error:', err);
      aiResponse = "Hi there! 😊 I'm having a bit of trouble accessing my information right now. Could you try asking your question again, or feel free to use the buttons below to get help!";
    }
    
    // Always append the two main buttons
    await sendSmartButtonsOrList({
      phoneNumberId,
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
  if (!session.step || session.step === 'home') {
    // WhatsApp allows only 3 buttons, so use a List for 4+ options
    await sendWhatsAppList({
      phoneNumberId,
      to: from,
      header: 'Welcome to Turf Booking! ⚽',
      body: 'Hi 👋\n\nI’m moksh, your virtual assistant for Turf Booking, ahmedabad. How can I help you today? Please select an option below:',
      button: 'Menu',
      rows: [
        { id: 'user_schedule_appt', title: 'Book Turf 🗓️' },
        { id: 'user_cancel_appt', title: 'Cancel Appointment ❌' },
         { id: 'user_reschedule_appt', title: 'Reschedule Appointment 🔁' },
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
      // Always start with service selection - first page
      const paginatedServices = getPaginatedServices(0);
      await sendWhatsAppList({
        phoneNumberId,
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
    } else if (userMsg === 'user_cancel_appt') {
      session.step = 'cancel_lookup';
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
      return;
    } else if (userMsg === 'user_reschedule_appt') {
      session.step = 'reschedule_lookup';
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
      return;
    } else if (userMsg === 'user_ask_question' || session.step === 'ask_question_topic') {
      await sendWhatsAppList({
        phoneNumberId,
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
      // Show pricing info with better formatting
      let pricingMsg = '💰 *Our Services & Pricing*\n\n';
      salonPricing.forEach(item => { // Salon pricing, see array for details
        pricingMsg += `• ${item.service}: ${item.price}\n`;
      });
      pricingMsg += '\nReady to book your appointment? I can help you schedule right away! 😊';
      await sendWhatsAppText({
        ...helperParams,
        to: from,
        body: pricingMsg
      });
      await sendSmartButtonsOrList({
        ...helperParams,
        to: from,
        header: undefined,
        body: 'What would you like to do next?',
        buttons: [
          { id: 'user_schedule_appt', title: 'Book Appointment' },
          { id: 'user_home', title: 'Back to Menu' }
        ]
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
          { id: 'user_cancel_appt', title: 'Cancel Appointment' },
          { id: 'user_reschedule_appt', title: 'Reschedule Appointment' },
          { id: 'user_ask_question', title: 'Ask a Question' },
          { id: 'user_home', title: 'Start Over' }
        ]
      });
      session.step = 'home_waiting';
      res.status(200).end();
      return;
    }
  }

  // Step 2: Service selection
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
          header: 'Book Appointment 💇‍♀️',
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
        header: 'Book Appointment ⚽',
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
        body: 'Great choice! 😊 I\'ll connect you with our stylist for a personalized session. Please provide your name and we\'ll schedule it for you.'
      });
      session.data.chosenService = 'Stylist Session';
      session.step = 'appt_name';
      res.status(200).end();
      return;
    }
    
    // Handle regular service selection
    const chosen = salonServices.find(s => s.id === userMsg || s.title.toLowerCase() === (userMsg || '').toLowerCase());
    if (chosen) {
      session.data.chosenService = chosen.title;
      // Step 3: Doctor selection
      await sendSmartButtonsOrList({
        ...helperParams,
        to: from,
        header: `Great! Which stylist would you prefer?`,
        body: 'Choose your stylist:',
        buttons: salonStylists
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
        header: 'Book Appointment 💇‍♀️',
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
      // Step 4: Date selection
      const days = await getAvailableBookingDays(session.data.stylist, calendars);
      
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
        buttons: salonStylists
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
        slotResult = await fetchRealTimeSlots(selectedDate, page, session.data.stylist, calendars);
        if (!slotResult.slots || slotResult.slots.length === 0) {
          // Check if this is today and provide a more helpful message
          const nowEAT = new Date().toLocaleString('en-US', { timeZone: 'Africa/Kampala' });
          const today = new Date(nowEAT).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
          
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
          phoneNumberId,
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
        buttons.push({ id: 'slot_next', title: '📄 Show More Slots' });
      }
      if (page > 0) {
        buttons.unshift({ id: 'slot_prev', title: '⏮️ Previous' });
      }
      buttons.push({ id: 'back_date', title: '🔙 Back' });
      await sendSmartButtonsOrList({
        phoneNumberId,
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
        phoneNumberId,
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
        phoneNumberId,
        to: from,
        body: `Perfect! You've chosen\n📅 ${session.data.date}, 🕐 ${time}\n\nJust a few quick details to lock it in 👇\n\nWhat's your full name?`
      });
      session.step = 'appt_name';
      res.status(200).end();
      return;
    } else {
      // Fallback: show time slots again (with pagination)
      const slotResult = session.data.slotResult;
      if (!slotResult || !slotResult.slots) {
        await sendWhatsAppText({
          phoneNumberId,
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
        buttons.push({ id: 'slot_next', title: '📄 Show More Slots' });
      }
      if (session.data.slotPage > 0) {
        buttons.unshift({ id: 'slot_prev', title: '⏮️ Previous' });
      }
      buttons.push({ id: 'back_date', title: '🔙 Back' });
      await sendSmartButtonsOrList({
        phoneNumberId,
        to: from,
        header: `Available time slots for ${session.data.date}:`,
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
              confirmationBody += `• Booking reminders\n\n*Using your previous preference: Accept All*`;
            } else if (lastAppointment.consent.appointmentReminders) {
              consentStatus = '📅 Reminders Only';
              confirmationBody += `• Booking reminders only\n\n*Using your previous preference: Reminders Only*`;
            } else {
              consentStatus = '❌ No Thanks';
              confirmationBody += `• No communications\n\n*Using your previous preference: No Thanks*`;
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
              phoneNumberId,
              to: from,
              header: '📋 Confirm Booking',
              body: confirmationBody,
              buttons: [
                { id: 'confirm_with_previous_consent', title: '✅ Confirm' },
                { id: 'change_consent_preferences', title: '🔄 Change' }
              ]
            });
            session.step = 'appt_confirm_with_previous_consent';
            res.status(200).end();
            return;
          }
        }
        
        // No previous consent or first-time user - show consent options
        await sendWhatsAppButtons({
          phoneNumberId,
          to: from,
          header: '📋 Booking Summary',
          body: `*Booking Details:*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n�‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n💅 *Service:* ${session.data.chosenService || 'General Salon Session'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\nWe'd like to send you:\n• Booking reminders\n• Birthday wishes\n\nPlease choose your preference:`,
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
          phoneNumberId,
          to: from,
          header: '📋 Booking Summary',
          body: `*Booking Details:*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n�‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n💅 *Service:* ${session.data.chosenService || 'General Salon Session'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\nWe'd like to send you:\n• Booking reminders\n• Birthday wishes\n\nPlease choose your preference:`,
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
        phoneNumberId,
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
          phoneNumberId,
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
        // Get start and end times from the selected slot (already in EAT)
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
        const stylist = session.data.stylist;
        const calendarId = stylistCalendars[stylist] || process.env.GCAL_CALENDAR_ID;
        
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
          phoneNumberId,
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
          consent: session.data.consent
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
        
        await Appointment.create(appointmentData);
        try {
          const io = req.app.get('socketio');
          if (io) {
            io.to(`client_${clientId}`).emit('appointments_update', { type: 'created' });
          }
        } catch {}
        
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
          phoneNumberId,
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
      
      const adminMsg = `*New Booking*\nName: ${session.data.name}\nPhone: ${session.data.phone}\nService: ${session.data.chosenService || ''}\nStylist: ${session.data.stylist || ''}\nDate: ${session.data.date}\nTime: ${session.data.time}\n${consentStatus}`;
      await notifyAdmins({ phoneNumberId, message: adminMsg });
      
      // Send confirmation to user based on consent
      let confirmationBody = `✅ *Booking Confirmed*\n\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n�‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n\n📍 *Location:* Salon Location\n🗺️ *Map:* https://maps.google.com/?q=Salon+Location\n\n⏰ *Please arrive 15 minutes early* for your appointment.`;
      
      // Add consent-specific confirmation message
      if (session.data.consent.appointmentReminders && session.data.consent.birthdayMessages) {
        confirmationBody += `\n\n🔔 *Appointment Reminders & Birthday Wishes:* You'll receive reminders before your appointments and birthday messages.\n\n❌ To stop receiving messages, reply with "STOP" at any time.`;
      } else if (session.data.consent.appointmentReminders) {
        confirmationBody += `\n\n📅 *Appointment Reminders Only:* You'll receive reminders before your appointments.\n\n❌ To stop receiving messages, reply with "STOP" at any time.`;
      } else {
        confirmationBody += `\n\n📱 *No Communications:* You've opted out of all messages.`;
      }
      
      await sendWhatsAppButtons({
        phoneNumberId,
        to: from,
        header: 'Got it 👍',
        body: confirmationBody,
        buttons: [
          { id: 'book_another', title: '📅 Book Another' },
          { id: 'home', title: '🏠 Home' }
        ]
      });
      
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
        phoneNumberId,
        to: from,
        header: '📋 Change Communication Preferences',
        body: `*Appointment Details:*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n�‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n💅 *Service:* ${session.data.chosenService || 'General Salon Session'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\nWe'd like to send you:\n• Appointment reminders\n• Birthday wishes\n\nPlease choose your preference:`,
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
        phoneNumberId,
        to: from,
        header: '📋 Confirm Appointment',
        body: `Please confirm your appointment or change your communication preferences.`,
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
          phoneNumberId,
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
        // Get start and end times from the selected slot (already in EAT)
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
        const stylist = session.data.stylist;
        const calendarId = calendars[stylist] || process.env.GCAL_CALENDAR_ID;
        
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
          phoneNumberId,
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
          consent: session.data.consent
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
        
        await Appointment.create(appointmentData);
        try {
          const io = req.app.get('socketio');
          if (io) {
            io.to(`client_${clientId}`).emit('appointments_update', { type: 'created' });
          }
        } catch {}
        
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
          phoneNumberId,
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
        consentStatus = '✅ Consented to appointment reminders and birthday messages';
      } else if (session.data.consent.appointmentReminders) {
        consentStatus = '📅 Consented to appointment reminders only';
      } else {
        consentStatus = '❌ Opted out of all communications';
      }
      
      const adminMsg = `*New Booking*\nName: ${session.data.name}\nPhone: ${session.data.phone}\nService: ${session.data.chosenService || ''}\nStylist: ${session.data.stylist || ''}\nDate: ${session.data.date}\nTime: ${session.data.time}\n${consentStatus}`;
      await notifyAdmins({ phoneNumberId, message: adminMsg });
      
      // Send confirmation to user based on consent
      let confirmationBody = `✅ *Appointment Confirmed*\n\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n�‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n\n📍 *Location:* Salon Location\n🗺️ *Map:* https://maps.google.com/?q=Salon+Location\n\n⏰ *Please arrive 15 minutes early* for your appointment.`;
      
      // Add consent-specific confirmation message
      if (session.data.consent.appointmentReminders && session.data.consent.birthdayMessages) {
        confirmationBody += `\n\n🔔 *Appointment Reminders & Birthday Wishes:* You'll receive reminders before your appointments and birthday messages.\n\n❌ To stop receiving messages, reply with "STOP" at any time.`;
      } else if (session.data.consent.appointmentReminders) {
        confirmationBody += `\n\n📅 *Appointment Reminders Only:* You'll receive reminders before your appointments.\n\n❌ To stop receiving messages, reply with "STOP" at any time.`;
      } else {
        confirmationBody += `\n\n📱 *No Communications:* You've opted out of all messages.`;
      }
      
      await sendWhatsAppButtons({
        phoneNumberId,
        to: from,
        header: 'Got it 👍',
        body: confirmationBody,
        buttons: [
          { id: 'book_another', title: '📅 Book Another' },
          { id: 'home', title: '🏠 Home' }
        ]
      });
      
      // Reset processing flag and clear session data
      session.data.isProcessing = false;
      session.step = 'home';
      session.data = {}; // Clear all session data
      
      console.log('✅ Appointment booking completed successfully for user:', from);
      
      res.status(200).end();
      return;
    } else {
      await sendWhatsAppButtons({
        phoneNumberId,
        to: from,
        header: '📋 Appointment Summary',
        body: `*Appointment Details:*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n�‍♀️ *Stylist:* ${session.data.stylist || 'Not specified'}\n💅 *Service:* ${session.data.chosenService || 'General Salon Session'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\nWe'd like to send you:\n• Appointment reminders\n• Birthday wishes\n\nPlease choose your preference:`,
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
          phoneNumberId,
          to: from,
          header: '⏰ Turf Hours',
          body: 'Great question! We\'re here to help you Monday through Saturday from 10:00 AM to 6:00 PM. We\'re closed on Sundays to give our team a well-deserved rest.\n\nIs there anything else I can help you with today? 😊',
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Turf' },
            { id: 'user_ask_question', title: 'Ask Question' },
            { id: 'user_home', title: 'Back to Menu' }
          ]
        });
      } else if (userMsg === 'faq_payment') {
        await sendSmartButtonsOrList({
          phoneNumberId,
          to: from,
          header: '💳 Payment Options',
          body: 'We make it easy to pay! We accept all major credit and debit cards, cash payments, and UPI transfers. We also work with select insurance providers to help cover your treatment costs.\n\nReady to schedule your appointment?',
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Turf' },
            { id: 'user_ask_question', title: 'Ask Question' },
            { id: 'user_home', title: 'Back to Menu' }
          ]
        });
      } else if (userMsg === 'faq_services') {
        await sendSmartButtonsOrList({
          phoneNumberId,
          to: from,
          header: '🦷 Our Services',
          body: 'We offer comprehensive turf services including field bookings, coaching sessions, equipment rentals, tournaments, and much more! Our experienced team is here to take care of all your turf needs.\n\nWould you like to know more about a specific service or book a turf session?',
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Turf' },
            { id: 'user_ask_question', title: 'Ask Question' },
            { id: 'user_home', title: 'Back to Menu' }
          ]
        });
      } else if (userMsg === 'faq_human') {
        await sendSmartButtonsOrList({
          phoneNumberId,
          to: from,
          header: '👨‍⚕ Talk to Our Team',
          body: 'Sure! I’ve noted your request.\n👨‍⚕ One of our team members will reach out to you shortly.\n\nIn the meantime, you can:',
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
        phoneNumberId,
        to: from,
        header: 'Oops! I didn’t catch that 🙈',
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
            phoneNumberId,
            to: from,
            header: 'Confirm Action',
            body: `Found your booking:\n${foundAppt.summary}\nDate: ${foundAppt.date}\nTime: ${foundAppt.time}\nDo you want to ${session.step === 'cancel_lookup' ? 'cancel' : 'reschedule'} this appointment?`,
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
            phoneNumberId,
            to: from,
            body: msg
          });
          session.step = session.step === 'cancel_lookup' ? 'cancel_pick_event' : 'reschedule_pick_event';
          res.status(200).end();
          return;
        } else {
          await sendWhatsAppText({
            phoneNumberId,
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
          phoneNumberId,
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
        phoneNumberId,
        to: from,
        header: 'Confirm Action',
        body: `You selected:\n${foundEvent.summary}\nDate: ${foundEvent.date}\nTime: ${foundEvent.time}\nStylist: ${foundEvent.stylist}\nDo you want to ${session.step === 'cancel_pick_event' ? 'cancel' : 'reschedule'} this appointment?`,
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
        phoneNumberId,
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
          phoneNumberId,
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
          phoneNumberId,
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
        phoneNumberId,
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
        phoneNumberId,
        to: from,
        header: 'Confirm Action',
        body: `Found your booking:\n${session.data.cancelEventSummary}\nDate: ${session.data.cancelEventDate}\nTime: ${session.data.cancelEventTime}\nDoctor: ${session.data.cancelDoctor}\nDo you want to cancel this booking?`,
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
          phoneNumberId,
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
          phoneNumberId,
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
          phoneNumberId,
          to: from,
          body: 'There was an error rescheduling your appointment. Please try again or contact support.'
        });
        session.step = 'home';
        res.status(200).end();
        return;
      }
    } else if (userMsg === 'confirm_no') {
      await sendWhatsAppText({
        phoneNumberId,
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
        phoneNumberId,
        to: from,
        header: 'Confirm Action',
        body: `Found your booking:\n${session.data.cancelEventSummary}\nDate: ${session.data.cancelEventDate}\nTime: ${session.data.cancelEventTime}\nDoctor: ${session.data.cancelDoctor}\nDo you want to reschedule this booking?`,
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
        phoneNumberId,
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
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        temperature: 0.8,
        max_tokens: 500,
        messages: [
          { 
            role: 'system', 
            content: 'You are Ava, a friendly turf booking assistant for Turf Booking in ahmedabad. Be conversational, warm, and helpful. Use natural language, appropriate emojis, and always sound like a real person. Reference the knowledge base for accurate information.' 
          },
          { role: 'user', content: prompt }
        ]
      });
      aiResponse = completion.choices[0].message.content.trim();
      
      // Ensure the response ends with a friendly closing if it doesn't already
      if (!aiResponse.toLowerCase().includes('need anything else') && 
          !aiResponse.toLowerCase().includes('anything else') &&
          !aiResponse.toLowerCase().includes('help you') &&
          !aiResponse.toLowerCase().includes('assistance')) {
        aiResponse += '\n\nNeed anything else I can help you with? 😊';
      }
      
    } catch (err) {
      console.error('OpenAI API error:', err);
      aiResponse = "Hi there! 😊 I'm having a bit of trouble accessing my information right now. Could you try asking your question again, or feel free to use the buttons below to get help!";
    }
    
    await sendSmartButtonsOrList({
      phoneNumberId,
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
          phoneNumberId,
          to: from,
          body: 'Sure! 😊 What would you like to know? Feel free to ask me anything about our services, pricing, hours, or anything else!'
        });
        session.step = 'faq_await';
        res.status(200).end();
        return;
      } else {
        await sendWhatsAppText({
          phoneNumberId,
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
    phoneNumberId,
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

// Helper: notify admins of new booking
async function notifyAdmins({ phoneNumberId, message }) {
  const adminNumbers = ['919313045439', '919484607042'];
  for (const adminNumber of adminNumbers) {
    await sendWhatsAppText({
      phoneNumberId,
      to: adminNumber,
      body: message
    });
  }
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
         } catch(e) { console.error('Client lookup failed:', e); }
    }

    const io = req.app.get('socketio');

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
            phoneNumberId,
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

    // Admin logic: if from admin number, use Step1.js flow
    const adminPhones = (req.clientConfig?.config?.adminPhones || ['919313045438', '919484607043']).map(p => String(p).replace(/\+/g, ''));
    
    if (adminPhones.includes(from.replace(/\+/g, ''))) {
      console.log('Admin logic triggered for', from);
      if (messages?.type === 'interactive') {
        const itf = messages.interactive;
        if (itf?.type === 'button_reply') {
          const buttonId = itf?.button_reply?.id;
          if (buttonId === '01_set_full_day_leave') {
            await sendAdminLeaveDateList({ phoneNumberId, to: messages.from, isFullDayLeave: true });
          } else if (buttonId === '01_set_partial_leave') {
            await sendAdminLeaveDateList({ phoneNumberId, to: messages.from, isFullDayLeave: false });
          }
        } else if (itf?.type === 'list_reply') {
          const selectedId = itf?.list_reply?.id;
          if (selectedId.startsWith('02full')) {
            // Full day leave selected for specific date
            const date = parseDateFromId(selectedId, '02full');
            try {
              // Save to MongoDB
              await DoctorScheduleOverride.create({ date, type: 'leave' });
              // Confirm and show menu again
              await sendLeaveConfirmationAndMenu({ phoneNumberId, to: from, date });
            } catch (err) {
              console.error('DB save error:', err);
            }
          } else if (selectedId.startsWith('02partial')) {
            partialDate = parseDateFromId(selectedId, '02partial');
            await sendPromptForTimeSlots({ phoneNumberId, to: from, date: partialDate });
            waitingForPartial = true;
          }
        }
      } else {
        if (waitingForPartial && messages.type === 'text') {
          const userText = messages.text.body;
          const prompt = `
            You are a time slot parser. Your job is to extract availability time ranges from a user's message and return them in a strict JSON format.
            Only respond with a valid JSON array of objects. Each object must have a start and end field in 24-hour format (HH:mm), no seconds.
            Do not include any text or explanation. Only return the array.
            Example input: I am available from 9am to 11am and again from 3pm to 6pm.
            Output:
            [
              { "start": "09:00", "end": "11:00" },
              { "start": "15:00", "end": "18:00" }
            ]
            Now extract from this input:
            "${userText}"
          `.trim();
          try {
            const resp = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo',
              temperature: 0,
              messages: [{ role: 'user', content: prompt }]
            });
            const jsonString = resp.choices[0].message.content;
            const timeSlots = JSON.parse(jsonString);
            await DoctorScheduleOverride.create({
              date: partialDate,
              type: 'custom_time',
              timeSlots
            });
            await sendPartialConfirmationAndMenu({
              phoneNumberId, to: from,
              date: partialDate, timeSlots
            });
          } catch (err) {
            console.error('Error parsing/saving partial slots:', err);
          } finally {
            waitingForPartial = false;
            partialDate = '';
          }
        } else if (!waitingForPartial) {
          await sendAdminInitialButtons({ phoneNumberId, to: messages.from });
        }
      }
      return res.sendStatus(200);
    } else {
      // All other users: user flow
      console.log('User logic (SALON BOOKING flow) triggered for', from);
      await handleUserChatbotFlow({ from, phoneNumberId, messages, res, clientConfig: req.clientConfig, io });
      return;
    }
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

