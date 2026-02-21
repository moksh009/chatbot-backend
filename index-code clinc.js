const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const { sendButtonMessage, sendChatbotMessage, sendAICallerMessage, sendBookDemoMessage } = require('./utils/Step1handlers');
const { sendLeaveConfirmationAndMenu, sendPromptForTimeSlots, sendPartialConfirmationAndMenu } = require('./utils/step2');
const { sendAdminInitialButtons, sendAdminLeaveDateList } = require('./utils/Step1');
const { parseDateFromId } = require('./utils/helpers');
const connectDB = require('./db');
const { DoctorScheduleOverride } = require('./models/DoctorScheduleOverride');
const fs = require('fs');
const { getAvailableTimeSlots, createEvent, updateEvent, deleteEvent, findEventByEmailAndTime, findEventsByPhoneNumber } = require('./utils/googleCalendar');
const { getAvailableDates } = require('./utils/getAvailableDates');
const { getAvailableSlots } = require('./utils/getAvailableSlots');
const Appointment = require('./models/Appointment');
const path = require('path');
const cron = require('node-cron');
const { DateTime } = require('luxon');
// Load birthday data
const birthdayData = require('./birthdays.json');
const { sendBirthdayWishWithImage } = require('./utils/sendBirthdayMessage');
// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const { GoogleGenerativeAI } = require('@google/generative-ai');
const BirthdayUser = require('./models/BirthdayUser');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

let isWaitingForTimeSlot = false;
let waitingForPartial = false;
let partialDate = '';

// Load knowledge base for OpenAI
const knowledgeBase = fs.readFileSync(path.join(__dirname, 'utils', 'knowledgeBase.txt'), 'utf8');

// In-memory state store for user sessions (for MVP; replace with Redis/DB for production)
const userSessions = {};

// Doctor to Calendar ID mapping
const doctorCalendars = {
  'Dr. Steven Mugabe': process.env.GCAL_CALENDAR_ID,
  'Dr. Angella Kissa': process.env.GCAL_CALENDAR_ID2,
};

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

// Helper to send WhatsApp interactive button message
async function sendWhatsAppButtons({ phoneNumberId, to, header, body, buttons }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
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
  } catch (err) {
    console.error('Error sending WhatsApp buttons:', err.response?.data || err.message);
  }
}

// Helper to send WhatsApp interactive list message (for day selection)
async function sendWhatsAppList({ phoneNumberId, to, header, body, button, rows }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
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
  } catch (err) {
    console.error('Error sending WhatsApp list:', err.response?.data || err.message);
  }
}

// Helper to send plain WhatsApp text message
async function sendWhatsAppText({ phoneNumberId, to, body }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
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
  } catch (err) {
    console.error('Error sending WhatsApp text:', err.response?.data || err.message);
  }
}

// Utility: Send buttons or list depending on count
async function sendSmartButtonsOrList({ phoneNumberId, to, header, body, buttons, fallbackButtonLabel = 'Select Option' }) {
  if (buttons.length > 3) {
    // Use WhatsApp list message
    await sendWhatsAppList({
      phoneNumberId,
      to,
      header,
      body,
      button: fallbackButtonLabel,
      rows: buttons.map(({ id, title }) => ({ id, title }))
    });
  } else {
    // Use WhatsApp button message
    await sendWhatsAppButtons({
      phoneNumberId,
      to,
      header,
      body,
      buttons
    });
  }
}

// Helper: get available booking days (dynamic, based on Google Calendar availability)
async function getAvailableBookingDays() {
  try {
    const doctor = (userSessions && Object.values(userSessions).find(s => s.data && s.data.doctor))?.data?.doctor;
    const calendarId = doctorCalendars[doctor] || process.env.GCAL_CALENDAR_ID;
    console.log('🔍 Fetching dynamic available dates from Google Calendar...');
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

// Real services from knowledge base - Comprehensive list
const codeClinicServices = [
  { id: 'service_consult', title: 'General Consultation' },
  { id: 'service_extraction', title: 'Tooth Extraction' },
  { id: 'service_surgical_extraction', title: 'Surgical Extraction' },
  { id: 'service_permanent_filling', title: 'Permanent Filling' },
  { id: 'service_temporary_filling', title: 'Temporary Filling' },
  { id: 'service_cleaning', title: 'Teeth Cleaning' },
  { id: 'service_rootcanal_molar', title: 'Root Canal (Molar)' },
  { id: 'service_rootcanal_premolar', title: 'Root Canal (Premolar)' },
  { id: 'service_xray', title: 'X-Ray' },
  { id: 'service_crowns', title: 'Dental Crowns' },
  { id: 'service_braces', title: 'Braces' },
  { id: 'service_clear_aligners', title: 'Clear Aligners' },
  { id: 'service_dentures_single', title: 'Dentures (Single)' },
  { id: 'service_dentures_flexible', title: 'Flexible Dentures' },
  { id: 'service_dentures_complete', title: 'Complete Dentures' },
  { id: 'service_veneers', title: 'Veneers' },
  { id: 'service_implants', title: 'Implants' },
  { id: 'service_whitening_office', title: 'Whitening (Office)' },
  { id: 'service_whitening_home', title: 'Whitening (Home)' },
  { id: 'service_retainers', title: 'Retainers' },
  { id: 'service_myobrace', title: 'Myobrace' }
];

// Helper function to get paginated services
function getPaginatedServices(page = 0) {
  const servicesPerPage = 8; // Show 8 services + "Ask Doctor" + "Choose Another Service"
  const startIndex = page * servicesPerPage;
  const endIndex = startIndex + servicesPerPage;
  const pageServices = codeClinicServices.slice(startIndex, endIndex);

  // Add "Ask Doctor" option
  pageServices.push({ id: 'service_ask_doctor', title: 'Ask Doctor' });

  // Add "Choose Another Service" if there are more services
  if (endIndex < codeClinicServices.length) {
    pageServices.push({ id: 'service_more', title: 'More Services' });
  }

  return {
    services: pageServices,
    currentPage: page,
    totalPages: Math.ceil(codeClinicServices.length / servicesPerPage),
    hasMore: endIndex < codeClinicServices.length
  };
}

// Real doctor(s)
const codeClinicDoctors = [
  { id: 'doctor_steven', title: 'Dr. Steven Mugabe' },
  { id: 'doctor_angella', title: 'Dr. Angella Kissa' }
];

// Helper: get pricing info from knowledge base
const codeClinicPricing = [
  { service: 'General Consultation', price: '40,000 UGX' },
  { service: 'Tooth Extraction', price: '100,000 UGX' },
  { service: 'Surgical Extraction', price: '450,000 UGX' },
  { service: 'Permanent Filling', price: '150,000 UGX' },
  { service: 'Teeth Cleaning', price: '130,000–200,000 UGX' },
  { service: 'Root Canal (Molar)', price: '450,000 UGX' },
  { service: 'Braces', price: 'Price depends on assessment' },
  { service: 'Implants', price: '1,500 USD' }
];

// Helper: get available time slots for a given date with pagination
async function fetchRealTimeSlots(dateStr, page = 0, doctor) {
  try {
    const calendarId = doctorCalendars[doctor] || process.env.GCAL_CALENDAR_ID;
    console.log(`🔍 Fetching available slots for ${dateStr} (page ${page}) with doctor ${doctor}...`);

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

// Detect greeting words
const GREETING_WORDS = ['hi', 'hello', 'hey', 'hii', 'good morning', 'good afternoon', 'good evening', 'greetings'];

// Add at the top for topic list
const QUESTION_TOPICS = [
  { id: 'ask_services', title: 'Services' },
  { id: 'ask_pricing', title: 'Pricing' },
  { id: 'ask_appointments', title: 'Appointments' },
  { id: 'ask_other', title: 'Something else' }
];

// Main user chatbot flow handler
async function handleUserChatbotFlow({ from, phoneNumberId, messages, res }) {
  const session = getUserSession(from);
  const userMsgType = messages.type;
  const userMsg = userMsgType === 'interactive' ? (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id) : messages.text?.body;

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
      header: 'Welcome to Code Clinic! 🦷',
      body: 'Hi 👋\n\nI’m Ava, your virtual assistant for Code Clinic, Kampala. How can I help you today? Please select an option below:',
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
    const bookingKeywords = ['book appointment', 'make appointment', 'schedule appointment', 'book visit', 'see doctor', 'book consultation'];
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
        header: 'Book Appointment 🦷',
        body: 'Perfect! I\'d be happy to help you book an appointment. 😊 Which service do you need?',
        button: 'Select Service',
        rows: paginatedServices.services
      });
      session.step = 'choose_service';
      session.data.servicePage = 0;
      res.status(200).end();
      return;
    }
    // Enhanced OpenAI prompt for precise, human-like responses
    const prompt = `You are Ava, a friendly dental clinic assistant for CODE CLINIC in Kampala, Uganda.

IMPORTANT INSTRUCTIONS:
1. Use the knowledge base below to provide accurate, helpful information
2. Keep responses SHORT and PRECISE (max 2-3 sentences)
3. Be conversational and warm, but direct to the point
4. Use 1-2 relevant emojis maximum
4. If asked about software/technology: "We use modern dental software for patient management and treatment planning."
5. If asked about pricing: Mention 2-3 top services only
6. If asked about hours: "We're open Monday-Saturday, 10 AM to 6 PM"
7. If question is NOT about dental services: Politely redirect to dental topics
8. If unsure: "I'd be happy to connect you with our team for specific questions"
9. End with a simple "Need anything else?" or "How can I help?"

KNOWLEDGE BASE:
${knowledgeBase}

USER QUESTION: ${userMsg}

Provide a SHORT, PRECISE response:`;

    let aiResponse = '';
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const fullPrompt = `System: You are Ava, a friendly dental clinic assistant for Code Clinic in Kampala. Be conversational, warm, and helpful. Use natural language, appropriate emojis, and always sound like a real person. Reference the knowledge base for accurate information.\n\nUser: ${prompt}`;
      const result = await model.generateContent(fullPrompt);
      aiResponse = result.response.text().trim();

      // Ensure the response ends with a friendly closing if it doesn't already
      if (!aiResponse.toLowerCase().includes('need anything else') &&
        !aiResponse.toLowerCase().includes('anything else') &&
        !aiResponse.toLowerCase().includes('help you') &&
        !aiResponse.toLowerCase().includes('assistance')) {
        aiResponse += '\n\nNeed anything else I can help you with? 😊';
      }

    } catch (err) {
      console.error('Gemini API error:', err);
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
      header: 'Welcome to Code Clinic! 🦷',
      body: 'Hi 👋\n\nI’m Ava, your virtual assistant for Code Clinic, Kampala. How can I help you today? Please select an option below:',
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

  // Home menu response
  if (session.step === 'home_waiting') {
    if (userMsg === 'user_schedule_appt') {
      // Always start with service selection - first page
      const paginatedServices = getPaginatedServices(0);
      await sendWhatsAppList({
        phoneNumberId,
        to: from,
        header: 'Book Appointment 🦷',
        body: 'Which service do you need?',
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
      codeClinicPricing.forEach(item => {
        pricingMsg += `• ${item.service}: ${item.price}\n`;
      });
      pricingMsg += '\nReady to book your appointment? I can help you schedule right away! 😊';
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: pricingMsg
      });
      await sendSmartButtonsOrList({
        phoneNumberId,
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
        phoneNumberId,
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
          phoneNumberId,
          to: from,
          header: 'Book Appointment 🦷',
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
        phoneNumberId,
        to: from,
        header: 'Book Appointment 🦷',
        body: prevPage === 0 ? 'Which service do you need?' : 'Choose from services:',
        button: 'Select Service',
        rows: paginatedServices.services
      });
      session.data.servicePage = prevPage;
      session.step = 'choose_service';
      res.status(200).end();
      return;
    }

    // Handle "Ask Doctor" option
    if (userMsg === 'service_ask_doctor') {
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Great choice! 😊 I\'ll connect you with our doctor for a personalized consultation. Please provide your name and we\'ll schedule a consultation appointment for you.'
      });
      session.data.chosenService = 'Doctor Consultation';
      session.step = 'appt_name';
      res.status(200).end();
      return;
    }

    // Handle regular service selection
    const chosen = codeClinicServices.find(s => s.id === userMsg || s.title.toLowerCase() === (userMsg || '').toLowerCase());
    if (chosen) {
      session.data.chosenService = chosen.title;
      // Step 3: Doctor selection
      await sendSmartButtonsOrList({
        phoneNumberId,
        to: from,
        header: `Great! Who would you like to see?`,
        body: 'Choose your doctor:',
        buttons: codeClinicDoctors
      });
      session.step = 'choose_doctor';
      res.status(200).end();
      return;
    } else {
      // Fallback: show current page of services again
      const currentPage = session.data.servicePage || 0;
      const paginatedServices = getPaginatedServices(currentPage);
      await sendWhatsAppList({
        phoneNumberId,
        to: from,
        header: 'Book Appointment 🦷',
        body: 'Please select a service:',
        button: 'Select Service',
        rows: paginatedServices.services
      });
      session.step = 'choose_service';
      res.status(200).end();
      return;
    }
  }

  // Step 3: Doctor selection
  if (session.step === 'choose_doctor') {
    const chosen = codeClinicDoctors.find(d => d.id === userMsg || d.title.toLowerCase() === (userMsg || '').toLowerCase());
    if (chosen) {
      session.data.doctor = chosen.title;
      // Step 4: Date selection
      const days = await getAvailableBookingDays();

      // Clean up the days array to only include WhatsApp-compatible properties
      const cleanDays = days.map(day => ({
        id: day.id,
        title: day.title
      }));

      await sendWhatsAppList({
        phoneNumberId,
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
      // Fallback: show doctor list again
      await sendSmartButtonsOrList({
        phoneNumberId,
        to: from,
        header: `Who would you like to see?`,
        body: 'Choose your doctor:',
        buttons: codeClinicDoctors
      });
      session.step = 'choose_doctor';
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
        slotResult = await fetchRealTimeSlots(selectedDate, page, session.data.doctor);
        if (!slotResult.slots || slotResult.slots.length === 0) {
          // Check if this is today and provide a more helpful message
          const nowIST = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
          const today = new Date(nowIST).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });

          if (selectedDate.toLowerCase().includes(today.toLowerCase())) {
            await sendWhatsAppText({
              phoneNumberId,
              to: from,
              body: 'Sorry, there are no available slots for today. This could be because:\n\n• All slots have already passed\n• We need at least 30 minutes advance notice for bookings\n• The clinic is closed for today\n\nPlease try selecting a different date! 😊'
            });
          } else {
            await sendWhatsAppText({
              phoneNumberId,
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
            let confirmationBody = `✅ *Appointment Summary*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n👨‍⚕️ *Doctor:* ${session.data.doctor || 'Not specified'}\n🏥 *Service:* ${session.data.chosenService || 'General Consultation'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\n`;

            if (lastAppointment.consent.appointmentReminders && lastAppointment.consent.birthdayMessages) {
              consentStatus = '✅ Accept All';
              confirmationBody += `• Appointment reminders\n• Birthday wishes\n\n*Using your previous preference: Accept All*`;
            } else if (lastAppointment.consent.appointmentReminders) {
              consentStatus = '📅 Reminders Only';
              confirmationBody += `• Appointment reminders only\n\n*Using your previous preference: Reminders Only*`;
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
              header: '📋 Confirm Appointment',
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
          header: '📋 Appointment Summary',
          body: `*Appointment Details:*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n👨‍⚕️ *Doctor:* ${session.data.doctor || 'Not specified'}\n🏥 *Service:* ${session.data.chosenService || 'General Consultation'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\nWe'd like to send you:\n• Appointment reminders\n• Birthday wishes\n\nPlease choose your preference:`,
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
          header: '📋 Appointment Summary',
          body: `*Appointment Details:*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n👨‍⚕️ *Doctor:* ${session.data.doctor || 'Not specified'}\n🏥 *Service:* ${session.data.chosenService || 'General Consultation'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\nWe'd like to send you:\n• Appointment reminders\n• Birthday wishes\n\nPlease choose your preference:`,
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
        const doctor = session.data.doctor;
        const calendarId = doctorCalendars[doctor] || process.env.GCAL_CALENDAR_ID;

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
        let eventDescription = `Name: ${session.data.name}\nPhone: ${session.data.phone}\nService: ${session.data.chosenService || ''}\nDoctor: ${session.data.doctor || ''}\nDate: ${session.data.date}\nTime: ${session.data.time}\nBooked via WhatsApp`;

        // Add consent status to event description
        if (session.data.consent.appointmentReminders && session.data.consent.birthdayMessages) {
          eventDescription += '\n\n🔔 User has consented to receive appointment reminders and birthday messages.';
        } else if (session.data.consent.appointmentReminders) {
          eventDescription += '\n\n📅 User has consented to receive appointment reminders only.';
        } else {
          eventDescription += '\n\n❌ User has opted out of all communications.';
        }

        const event = await createEvent({
          summary: `Appointment: ${session.data.name} - ${session.data.chosenService || ''} with ${session.data.doctor || ''}`,
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
          doctor: session.data.doctor
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
          doctor: session.data.doctor || '', // Changed from stylist to doctor to match the model
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

      const adminMsg = `*New Booking*\nName: ${session.data.name}\nPhone: ${session.data.phone}\nService: ${session.data.chosenService || ''}\nDoctor: ${session.data.doctor || ''}\nDate: ${session.data.date}\nTime: ${session.data.time}\n${consentStatus}`;
      await notifyAdmins({ phoneNumberId, message: adminMsg });

      // Send confirmation to user based on consent
      let confirmationBody = `✅ *Appointment Confirmed*\n\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n👨‍⚕️ *Doctor:* ${session.data.doctor || 'Not specified'}\n\n📍 *Location:* Code Clinic\n🗺️ *Map:* https://maps.google.com/?q=Code+Clinic\n\n⏰ *Please arrive 15 minutes early* for your appointment.`;

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
        body: `*Appointment Details:*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n👨‍⚕️ *Doctor:* ${session.data.doctor || 'Not specified'}\n🏥 *Service:* ${session.data.chosenService || 'General Consultation'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\nWe'd like to send you:\n• Appointment reminders\n• Birthday wishes\n\nPlease choose your preference:`,
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
        const doctor = session.data.doctor;
        const calendarId = doctorCalendars[doctor] || process.env.GCAL_CALENDAR_ID;

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
        let eventDescription = `Name: ${session.data.name}\nPhone: ${session.data.phone}\nService: ${session.data.chosenService || ''}\nDoctor: ${session.data.doctor || ''}\nDate: ${session.data.date}\nTime: ${session.data.time}\nBooked via WhatsApp`;

        // Add consent status to event description
        if (session.data.consent.appointmentReminders && session.data.consent.birthdayMessages) {
          eventDescription += '\n\n🔔 User has consented to receive appointment reminders and birthday messages.';
        } else if (session.data.consent.appointmentReminders) {
          eventDescription += '\n\n📅 User has consented to receive appointment reminders only.';
        } else {
          eventDescription += '\n\n❌ User has opted out of all communications.';
        }

        const event = await createEvent({
          summary: `Appointment: ${session.data.name} - ${session.data.chosenService || ''} with ${session.data.doctor || ''}`,
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
          doctor: session.data.doctor
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
          doctor: session.data.doctor || '', // Changed from stylist to doctor to match the model
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

      const adminMsg = `*New Booking*\nName: ${session.data.name}\nPhone: ${session.data.phone}\nService: ${session.data.chosenService || ''}\nDoctor: ${session.data.doctor || ''}\nDate: ${session.data.date}\nTime: ${session.data.time}\n${consentStatus}`;
      await notifyAdmins({ phoneNumberId, message: adminMsg });

      // Send confirmation to user based on consent
      let confirmationBody = `✅ *Appointment Confirmed*\n\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n👨‍⚕️ *Doctor:* ${session.data.doctor || 'Not specified'}\n\n📍 *Location:* Code Clinic\n🗺️ *Map:* https://maps.google.com/?q=Code+Clinic\n\n⏰ *Please arrive 15 minutes early* for your appointment.`;

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
        body: `*Appointment Details:*\n\n👤 *Name:* ${session.data.name}\n📅 *Date:* ${session.data.date}\n🕒 *Time:* ${session.data.time}\n👨‍⚕️ *Doctor:* ${session.data.doctor || 'Not specified'}\n🏥 *Service:* ${session.data.chosenService || 'General Consultation'}\n\n📱 *Phone:* ${session.data.phone}\n\n🔔 *Communication Preferences:*\nWe'd like to send you:\n• Appointment reminders\n• Birthday wishes\n\nPlease choose your preference:`,
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
          header: '⏰ Our Clinic Hours',
          body: 'Great question! We\'re here to help you Monday through Saturday from 10:00 AM to 6:00 PM. We\'re closed on Sundays to give our team a well-deserved rest.\n\nIs there anything else I can help you with today? 😊',
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Appointment' },
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
            { id: 'user_schedule_appt', title: 'Book Appointment' },
            { id: 'user_ask_question', title: 'Ask Question' },
            { id: 'user_home', title: 'Back to Menu' }
          ]
        });
      } else if (userMsg === 'faq_services') {
        await sendSmartButtonsOrList({
          phoneNumberId,
          to: from,
          header: '🦷 Our Services',
          body: 'We offer comprehensive dental care including consultations, cleanings, extractions, root canals, braces, and much more! Our experienced team is here to take care of all your dental needs.\n\nWould you like to know more about a specific service or book an appointment?',
          buttons: [
            { id: 'user_schedule_appt', title: 'Book Appointment' },
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
            { id: 'user_schedule_appt', title: 'Book Appointment' },
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
          { id: 'faq_hours', title: 'Clinic Hours' },
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
        // Search in Dr. Steven's calendar
        const stevenAppointments = await findEventsByPhoneNumber({
          phone: phoneNumber,
          startDate,
          endDate,
          calendarId: process.env.GCAL_CALENDAR_ID
        });
        stevenAppointments.forEach(apt => {
          apt.calendarId = process.env.GCAL_CALENDAR_ID;
          apt.doctor = 'Dr. Steven Mugabe';
        });
        allAppointments.push(...stevenAppointments);
        // Search in Dr. Angella's calendar
        const angellaAppointments = await findEventsByPhoneNumber({
          phone: phoneNumber,
          startDate,
          endDate,
          calendarId: process.env.GCAL_CALENDAR_ID2
        });
        angellaAppointments.forEach(apt => {
          apt.calendarId = process.env.GCAL_CALENDAR_ID2;
          apt.doctor = 'Dr. Angella Kissa';
        });
        allAppointments.push(...angellaAppointments);
        if (allAppointments.length === 1) {
          // Only one appointment found, proceed to confirmation
          const foundAppt = allAppointments[0];
          session.data.cancelEventId = foundAppt.eventId;
          session.data.cancelEventSummary = foundAppt.summary;
          session.data.cancelEventDate = foundAppt.date;
          session.data.cancelEventTime = foundAppt.time;
          session.data.cancelCalendarId = foundAppt.calendarId;
          session.data.cancelDoctor = foundAppt.doctor;
          await sendWhatsAppButtons({
            phoneNumberId,
            to: from,
            header: 'Confirm Action',
            body: `Found your appointment:\n${foundAppt.summary}\nDate: ${foundAppt.date}\nTime: ${foundAppt.time}\nDoctor: ${foundAppt.doctor}\nDo you want to ${session.step === 'cancel_lookup' ? 'cancel' : 'reschedule'} this appointment?`,
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
            doctor: a.doctor
          }));
          let msg = 'We found multiple appointments for your number. *Please reply with the number to select:*\n\n';
          session.data.cancelEventChoices.forEach((ev, idx) => {
            msg += `${idx + 1}️⃣ ${ev.summary} with ${ev.doctor}\n    📅 ${ev.date}   ⏰ ${ev.time}\n\n`;
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
            body: 'No appointment found for your WhatsApp number. Please check and try again.'
          });
          session.step = 'home';
          res.status(200).end();
          return;
        }
      } catch (err) {
        console.error('Error searching appointments:', err);
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: 'Sorry, there was an error searching for your appointments. Please try again later.'
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
      session.data.cancelDoctor = foundEvent.doctor;
      await sendWhatsAppButtons({
        phoneNumberId,
        to: from,
        header: 'Confirm Action',
        body: `You selected:\n${foundEvent.summary}\nDate: ${foundEvent.date}\nTime: ${foundEvent.time}\nDoctor: ${foundEvent.doctor}\nDo you want to ${session.step === 'cancel_pick_event' ? 'cancel' : 'reschedule'} this appointment?`,
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
        body: 'Invalid selection. Please reply with the number of the appointment you want to select.'
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
          body: 'Your appointment has been cancelled. The slot is now free and available for others to book.'
        });
      } catch (err) {
        console.error('Error cancelling appointment:', err);
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: 'There was an error cancelling your appointment. Please try again or contact support.'
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
        body: `Found your appointment:\n${session.data.cancelEventSummary}\nDate: ${session.data.cancelEventDate}\nTime: ${session.data.cancelEventTime}\nDoctor: ${session.data.cancelDoctor}\nDo you want to cancel this appointment?`,
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
          body: 'Your previous appointment has been cancelled and the slot is now free for others.'
        });
        // Reset session data for new booking, but keep phone for convenience
        const userPhone = session.data.cancelReschedulePhoneValue;
        session.data = { phone: userPhone };
        // Send the same initial message as "Book Appointment" flow
        const paginatedServices = getPaginatedServices(0);
        await sendWhatsAppList({
          phoneNumberId,
          to: from,
          header: 'Book Appointment 🦷',
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
        body: 'Reschedule aborted. Your appointment is still active.'
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
        body: `Found your appointment:\n${session.data.cancelEventSummary}\nDate: ${session.data.cancelEventDate}\nTime: ${session.data.cancelEventTime}\nDoctor: ${session.data.cancelDoctor}\nDo you want to reschedule this appointment?`,
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
        header: 'Book Appointment 🦷',
        body: 'Perfect! I\'d be happy to help you book an appointment. 😊 Which service do you need?',
        button: 'Select Service',
        rows: paginatedServices.services
      });
      session.step = 'choose_service';
      session.data.servicePage = 0;
      res.status(200).end();
      return;
    }

    // Enhanced OpenAI prompt for FAQ responses
    const prompt = `You are Ava, a friendly and knowledgeable assistant for CODE CLINIC dental practice in Kampala, Uganda. 

IMPORTANT INSTRUCTIONS:
1. Use the knowledge base below to provide accurate, helpful information
2. Be warm, conversational, and professional - like a real person
3. Use natural language with appropriate emojis
4. If asked about pricing, mention 4-5 top services only and suggest booking for specific treatments
5. If asked about booking, encourage them to type "book appointment" or use the button
6. If asked about hours, always mention the specific working hours from the knowledge base
7. If the answer is not in the knowledge base, suggest calling the clinic or emailing
8. Always end responses with "Need anything else?" or similar friendly closing
9. For identity questions, use the specific response from the knowledge base

KNOWLEDGE BASE:
${knowledgeBase}

USER QUESTION: ${messages.text?.body || userMsg}

Please provide a helpful, human-like response:`;

    let aiResponse = '';
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const fullPrompt = `System: You are Ava, a friendly dental clinic assistant for Code Clinic in Kampala. Be conversational, warm, and helpful. Use natural language, appropriate emojis, and always sound like a real person. Reference the knowledge base for accurate information.\n\nUser: ${prompt}`;
      const result = await model.generateContent(fullPrompt);
      aiResponse = result.response.text().trim();

      // Ensure the response ends with a friendly closing if it doesn't already
      if (!aiResponse.toLowerCase().includes('need anything else') &&
        !aiResponse.toLowerCase().includes('anything else') &&
        !aiResponse.toLowerCase().includes('help you') &&
        !aiResponse.toLowerCase().includes('assistance')) {
        aiResponse += '\n\nNeed anything else I can help you with? 😊';
      }

    } catch (err) {
      console.error('Gemini API error:', err);
      aiResponse = "Hi there! 😊 I'm having a bit of trouble accessing my information right now. Could you try asking your question again, or feel free to use the buttons below to get help!";
    }

    await sendSmartButtonsOrList({
      phoneNumberId,
      to: from,
      header: undefined,
      body: aiResponse,
      buttons: [
        { id: 'user_schedule_appt', title: 'Book Appointment' },
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
      { id: 'user_schedule_appt', title: 'Book Appointment' },
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

// Homepage endpoint
app.get('/homepage', (req, res) => {
  res.status(200).json({
    message: 'Hello World',
    status: 'success'
  });
});



const verifyToken = process.env.VERIFY_TOKEN;

// Route for GET requests
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});


// Whatsapp webhook that it hits when we send message to the bot
app.post('/', async (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

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
    if (
      from === '919313045438' || from === '+919313045438' ||
      from === '919484607043' || from === '+919484607043'
    ) {
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
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(prompt);
            const jsonString = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
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
      console.log('User logic (CODE CLINIC flow) triggered for', from);
      await handleUserChatbotFlow({ from, phoneNumberId, messages, res });
      return;
    }
  } catch (err) {
    console.error('Error extracting data from webhook payload:', err);
  }
  res.status(200).end();
});

app.post('/keepalive-ping', (req, res) => {
  console.log(`🔁 Keepalive ping received at ${new Date().toISOString()}`);
  res.status(200).json({ message: 'Server is awake!' });
});

// Cron job for birthday messages and appointment reminders
cron.schedule('0 6 * * *', async () => {
  const istNow = DateTime.utc().setZone('Asia/Kolkata');
  const currentDay = istNow.day;
  const currentMonth = istNow.month;
  const token = process.env.WHATSAPP_TOKEN;
  const phoneid = process.env.WHATSAPP_PHONENUMBER_ID;

  console.log(`⏰ It's 6:00 AM IST — Running birthday check...`);

  try {
    // Send birthday messages to users who have consented
    const todaysBirthdays = await BirthdayUser.find({
      day: currentDay,
      month: currentMonth,
      isOpted: true,
    });

    console.log(`🎉 Found ${todaysBirthdays.length} birthday(s) to process`);

    let successCount = 0;
    let failureCount = 0;

    for (const user of todaysBirthdays) {
      try {
        const result = await sendBirthdayWishWithImage(user.number, token, phoneid);
        if (result.success) {
          successCount++;
        } else {
          failureCount++;
          console.log(`❌ Birthday message failed for ${user.number}: ${result.reason || result.error}`);
        }

        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`❌ Error sending birthday message to ${user.number}:`, error.message);
        failureCount++;
      }
    }

    console.log(`🎂 Birthday messages completed: ${successCount} sent, ${failureCount} failed`);

  } catch (error) {
    console.error('❌ Error in birthday cron job:', error.message);
  }
});

// Cron job for appointment reminders (run daily at 7 AM)
cron.schedule('0 7 * * *', async () => {
  const istNow = DateTime.utc().setZone('Asia/Kolkata');
  const today = istNow.toFormat('EEEE, dd MMM');
  const token = process.env.WHATSAPP_TOKEN;
  const phoneid = process.env.WHATSAPP_PHONENUMBER_ID;

  console.log(`⏰ Running appointment reminder check for today (${today})...`);

  try {
    // Get all events from Google Calendar for today
    const startOfDay = istNow.startOf('day').toISO();
    const endOfDay = istNow.endOf('day').toISO();

    // Get events from both doctor calendars
    const calendarIds = [process.env.GCAL_CALENDAR_ID, process.env.GCAL_CALENDAR_ID2];
    const { listEvents } = require('./utils/googleCalendar');

    let allTodayEvents = [];

    for (const calendarId of calendarIds) {
      try {
        const events = await listEvents(startOfDay, endOfDay, calendarId);
        allTodayEvents = allTodayEvents.concat(events);
      } catch (error) {
        console.error(`❌ Error fetching events from calendar ${calendarId}:`, error.message);
      }
    }

    console.log(`📅 Found ${allTodayEvents.length} events in Google Calendar for today`);

    // Process each event and send reminders to users who have consented
    for (const event of allTodayEvents) {
      try {
        // Extract phone number from event description
        const phoneMatch = event.description?.match(/Phone:\s*([^\n]+)/);
        if (!phoneMatch) {
          console.log(`⚠️ No phone number found in event: ${event.summary}`);
          continue;
        }

        const phoneNumber = phoneMatch[1].trim();

        // Check if user has consented to appointment reminders
        const userAppointments = await Appointment.find({
          phone: phoneNumber,
          'consent.appointmentReminders': true
        });

        if (userAppointments.length === 0) {
          console.log(`❌ Skipping reminder for ${phoneNumber} - user has not consented to reminders`);
          continue;
        }

        // Extract appointment details from event
        const nameMatch = event.description?.match(/Name:\s*([^\n]+)/);
        const serviceMatch = event.description?.match(/Service:\s*([^\n]+)/);
        const doctorMatch = event.description?.match(/Doctor:\s*([^\n]+)/);

        const patientName = nameMatch ? nameMatch[1].trim() : "Valued Patient";
        const service = serviceMatch ? serviceMatch[1].trim() : "Dental Service";
        const doctor = doctorMatch ? doctorMatch[1].trim() : "Our Doctor";

        // Format appointment time
        const eventTime = DateTime.fromISO(event.start.dateTime).setZone('Asia/Kolkata');
        const time = eventTime.toFormat('h:mm a');

        // Send appointment reminder using template
        const { sendAppointmentReminder } = require('./utils/sendAppointmentReminder');
        await sendAppointmentReminder(phoneid, token, phoneNumber, {
          summary: event.summary,
          start: event.start.dateTime,
          doctor: doctor,
          date: today,
          time: time
        });

        console.log(`✅ Appointment reminder sent to ${phoneNumber} for ${time}`);

        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`❌ Error processing appointment reminder for event ${event.id}:`, error.message);
      }
    }

    console.log(`🎯 Appointment reminders completed for ${today}`);

  } catch (err) {
    console.error('❌ Error in appointment reminder cron job:', err);
  }
});

console.log(`Starting server on port ${PORT}...`);
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed", err);
    process.exit(1);
  });

module.exports = app;
