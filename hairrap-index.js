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
const { getAvailableTimeSlots, createEvent, updateEvent, deleteEvent, findEventByEmailAndTime } = require('./utils/googleCalendar');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let isWaitingForTimeSlot = false;
let waitingForPartial   = false;
let partialDate         = '';

// Load knowledge base for OpenAI
const knowledgeBase = fs.readFileSync(require('path').join(__dirname, 'utils', 'knowledgeBase.txt'), 'utf8');

// In-memory state store for user sessions (for MVP; replace with Redis/DB for production)
const userSessions = {};

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
  // Truncate header to 60 chars max
  let safeHeader = header;
  if (header && header.length > 60) {
    safeHeader = header.slice(0, 60);
  }
  const data = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: safeHeader ? { type: 'text', text: safeHeader } : undefined,
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
  if (!safeHeader) delete data.interactive.header;
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

// Helper: send WhatsApp image with caption
async function sendWhatsAppImage({ phoneNumberId, to, imageUrl, caption }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: {
      link: imageUrl,
      caption: caption
    }
  };
  try {
    await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
  } catch (err) {
    console.error('Error sending WhatsApp image:', err.response?.data || err.message);
  }
}

// Helper: send WhatsApp catalog (multi-product) message
async function sendWhatsAppCatalog({ phoneNumberId, to, catalogId, sections }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'catalog',
    catalog_id: catalogId,
    sections
  };
  try {
    await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
  } catch (err) {
    console.error('Error sending WhatsApp catalog:', err.response?.data || err.message);
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

// Helper: get available days (Mon-Sat, disable Sun)
function getAvailableDays() {
  return [
    { id: 'day_monday',    title: 'Monday' },
    { id: 'day_tuesday',   title: 'Tuesday' },
    { id: 'day_wednesday', title: 'Wednesday' },
    { id: 'day_thursday',  title: 'Thursday' },
    { id: 'day_friday',    title: 'Friday' },
    { id: 'day_saturday',  title: 'Saturday' }
    // Sunday intentionally omitted
  ];
}

// Helper: get available time slots for a given date from Google Calendar
async function fetchRealTimeSlots(dateStr) {
  // dateStr: '22 July 2025' or similar
  // Convert to YYYY-MM-DD
  let dateObj;
  try {
    dateObj = new Date(dateStr);
    if (isNaN(dateObj)) {
      // Try parsing 'Tuesday 22 Jul' etc
      const parts = dateStr.split(' ');
      if (parts.length >= 3) {
        const day = parts[1].padStart(2, '0');
        const month = parts[2].substring(0, 3);
        const year = parts[3] || new Date().getFullYear();
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const monthNum = (months.indexOf(month) + 1).toString().padStart(2, '0');
        dateObj = new Date(`${year}-${monthNum}-${day}`);
      }
    }
  } catch {
    dateObj = new Date();
  }
  const yyyy = dateObj.getFullYear();
  const mm = (dateObj.getMonth() + 1).toString().padStart(2, '0');
  const dd = dateObj.getDate().toString().padStart(2, '0');
  const isoDate = `${yyyy}-${mm}-${dd}`;
  try {
    let slots = await getAvailableTimeSlots({ date: isoDate, startTime: '09:00', endTime: '23:00', slotMinutes: 60 });
    // Filter out past slots if the date is today
    const now = new Date();
    const isToday = now.toISOString().slice(0, 10) === isoDate;
    if (isToday) {
      slots = slots.filter(slot => new Date(slot.start) > now);
    }
    // Format for WhatsApp display: '10:00 AM', etc
    const formatted = slots.map(slot => {
      const start = new Date(slot.start);
      let hour = start.getHours();
      const min = start.getMinutes();
      const ampm = hour >= 12 ? 'PM' : 'AM';
      hour = hour % 12;
      if (hour === 0) hour = 12;
      return `${hour}:${min.toString().padStart(2, '0')} ${ampm}`;
    });
    return formatted;
  } catch (err) {
    console.error('Error fetching real time slots:', err);
    return [];
  }
}

// Helper: get available days (Mon-Sat, disable Sun)
function getAvailableBookingDays() {
  const days = [];
  // Always use Asia/Kolkata timezone for business hour logic
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const businessStart = new Date(now);
  businessStart.setHours(9, 0, 0, 0);
  const businessEnd = new Date(now);
  businessEnd.setHours(21, 0, 0, 0);
  // If now is within business hours, allow today
  let startOffset = 0;
  if (now < businessStart || now >= businessEnd) {
    // Outside business hours, skip today
    startOffset = 1;
  }
  for (let i = startOffset; i < startOffset + 7; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' });
    days.push({ id: `calendar_day_${i}`, title: label });
  }
  return days;
}

// Main user chatbot flow handler
async function handleUserChatbotFlow({ from, phoneNumberId, messages, res }) {
  const session = getUserSession(from);
  const userMsgType = messages.type;
  const userMsg = userMsgType === 'interactive' ? (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id) : messages.text?.body?.trim().toLowerCase();
  console.log('UserMsgType:', userMsgType, 'UserMsg:', userMsg, 'SessionStep:', session.step);

  // Universal menu keyword
  if (userMsg === 'menu' || userMsg === 'home' || userMsg === 'go to home' || userMsg === 'main menu') {
    session.step = 'main_menu';
  }

  // Main menu WhatsApp list (8 options)
  if (!session.step || session.step === 'main_menu' || session.step === 'home') {
    await sendWhatsAppList({
      phoneNumberId,
      to: from,
      header: 'Hi 👋',
      body: 'Welcome to *Hair Rap by Yoyo*! 💈✨\nIndia’s trendiest hair transformation salon.\n\nHow can I help you today? Please select an option below 👇',
      button: 'Menu',
      rows: [
        { id: 'book_appt', title: 'Book Appointment ✂️' },
        { id: 'cancel_appt', title: 'Cancel Appointment ❌' },
        { id: 'reschedule', title: 'Reschedule Appointment 🔁' },
        { id: 'modify_booking', title: 'Modify Booking 🛠️' },
        { id: 'hair_stylists', title: 'Hair Stylists 💇' },
        { id: 'pricing', title: 'Pricing 💰' },
        { id: 'ask_question', title: 'Ask a Question ❓' },
        { id: 'talk_human', title: 'Talk to Human 🧑‍💼' }
      ]
    });
    session.step = 'main_menu_waiting';
    res.status(200).end();
    return;
  }

  // Main menu waiting: handle each option
  if (session.step === 'main_menu_waiting') {
    if (userMsg === 'book_appt') {
      // Book Appointment flow: Service selection
      await sendWhatsAppList({
        phoneNumberId,
        to: from,
        header: 'Book Appointment ✂️',
        body: 'Please choose a service:',
        button: 'Select Service',
        rows: [
          { id: 'service_haircut', title: 'Haircut' },
          { id: 'service_color', title: 'Hair Color' },
          { id: 'service_keratin', title: 'Keratin Treatment' },
          { id: 'service_spa', title: 'Hair Spa' },
          { id: 'service_beard', title: 'Beard Trim' },
          { id: 'service_styling', title: 'Hair Styling' },
          { id: 'back_main', title: 'Back' }
        ]
      });
      session.step = 'choose_service';
      res.status(200).end();
      return;
    } else if (userMsg === 'cancel_appt') {
      // Cancel Appointment flow
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Sorry to hear that! Please share your booking details (email or name) and we’ll locate your appointment.'
      });
      session.step = 'cancel_lookup';
      res.status(200).end();
      return;
    } else if (userMsg === 'reschedule') {
      // Reschedule flow
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Sure! Let’s reschedule. Please provide your email or name to locate your booking.'
      });
      session.step = 'reschedule_lookup';
      res.status(200).end();
      return;
    } else if (userMsg === 'modify_booking') {
      // Modify Booking flow
      await sendWhatsAppList({
        phoneNumberId,
        to: from,
        header: 'Modify Booking 🛠️',
        body: 'What would you like to modify?',
        button: 'Modify',
        rows: [
          { id: 'mod_artist', title: 'Change Artist' },
          { id: 'mod_date', title: 'Change Date' },
          { id: 'mod_time', title: 'Change Time' },
          { id: 'mod_service', title: 'Change Service' },
          { id: 'back_main', title: 'Back' }
        ]
      });
      session.step = 'modify_what';
      res.status(200).end();
      return;
    } else if (userMsg === 'hair_stylists') {
      // Hair Stylists info (no catalog)
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: `Here are our expert stylists at *Hair Rap by Yoyo* (Kolkata, West Bengal):\n\n1. *Yoyo* – Founder & Lead Artist 👑\n2. *Maddy* – Color Specialist 🌈\n3. *Prince* – Hair Spa & Styling 💆‍♂️\n4. *Shiv* – Beard & Haircut Pro ✂️\n\nLet us know if you want to book with someone directly!`
      });
      await sendSmartButtonsOrList({
        phoneNumberId,
        to: from,
        header: undefined,
        body: 'Want to book with a stylist or return to menu?',
        buttons: [
          { id: 'book_appt', title: 'Book Appt' },
          { id: 'main_menu', title: 'Menu' }
        ]
      });
      session.step = 'main_menu_waiting';
      res.status(200).end();
      return;
    } else if (userMsg === 'pricing') {
      // Pricing info (no catalog)
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: `Here’s our pricing catalog 💵\n\n✨ Haircut – ₹500\n🌈 Hair Color – ₹1,200\n💆 Keratin – ₹2,500\n🧴 Hair Spa – ₹1,000\n✂️ Beard Trim – ₹300\n👑 Hair Styling – ₹800\n\nAll services include expert consultation. Book now to glam up! 💇‍♀️`
      });
      await sendSmartButtonsOrList({
        phoneNumberId,
        to: from,
        header: undefined,
        body: 'Want to book a service or return to menu?',
        buttons: [
          { id: 'book_appt', title: 'Book Appt' },
          { id: 'main_menu', title: 'Menu' }
        ]
      });
      session.step = 'main_menu_waiting';
      res.status(200).end();
      return;
    } else if (userMsg === 'ask_question') {
      // Ask a Question (AI/FAQ)
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Sure! Ask me anything about our services, stylists, or appointments.'
      });
      session.step = 'faq_await';
      res.status(200).end();
      return;
    } else if (userMsg === 'talk_human') {
      // Talk to Human
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Please share your concern. A team member will connect with you shortly 💬\nWe usually respond within 10-15 mins.'
      });
      session.step = 'await_human_query';
      res.status(200).end();
      return;
    } else {
      // Fallback: show menu again
      session.step = 'main_menu';
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
      return;
    }
  }

  // Step 2: Book Appointment - Choose Service
  if (session.step === 'choose_service') {
    let chosenService = '';
    if (userMsg === 'service_haircut' || userMsg === '💇 Haircut') chosenService = 'Haircut';
    else if (userMsg === 'service_color' || userMsg === '🎨 Hair Coloring') chosenService = 'Hair Coloring';
    else if (userMsg === 'service_keratin' || userMsg === 'Keratin Treatment') chosenService = 'Keratin Treatment';
    else if (userMsg === 'service_spa' || userMsg === '💆‍♀️ Hair Spa') chosenService = 'Hair Spa';
    else if (userMsg === 'back_main') { session.step = 'main_menu'; await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res }); return; }
    if (chosenService) {
      session.data.chosenService = chosenService;
      console.log('Booking: Service selected:', chosenService);
      // Choose stylist
      await sendSmartButtonsOrList({
        phoneNumberId,
        to: from,
        header: `Great choice! ✂️ Choose your preferred stylist:`,
        body: 'Select a stylist:',
        buttons: [
          { id: 'stylist_yoyo', title: '✂️ Yoyo (8+ yrs exp)' },
          { id: 'stylist_priya', title: '💎 Priya (5 yrs exp)' },
          { id: 'stylist_shanaya', title: '🔥 Shanaya (4 yrs exp)' },
          { id: 'stylist_first', title: '🧿 First Available' },
          { id: 'back_service', title: '🔙 Back' }
        ]
      });
      session.step = 'choose_stylist';
      res.status(200).end();
      return;
    } else {
      // Fallback: show service list again
      session.step = 'main_menu';
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
      return;
    }
  }

  // In choose_stylist, robustly match stylist selection regardless of input format
  if (session.step === 'choose_stylist') {
    // Normalize user input
    const normalizedMsg = (userMsg || '').trim().toLowerCase().replace(/[^a-z0-9 ]/gi, '');
    // Mapping of possible stylist names/ids to canonical name
    const stylistMap = {
      'stylistyoyo': 'Yoyo',
      'yoyo': 'Yoyo',
      'stylistpriya': 'Priya',
      'priya': 'Priya',
      'stylistshanaya': 'Shanaya',
      'shanaya': 'Shanaya',
      'stylistfirst': 'First Available',
      'firstavailable': 'First Available',
      'first available': 'First Available',
      'backservice': 'BACK',
      'back': 'BACK'
    };
    let stylist = stylistMap[normalizedMsg] || '';
    if (stylist === 'BACK') {
      session.step = 'choose_service';
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
      return;
    }
    if (stylist) {
      session.data.stylist = stylist;
      console.log('Booking: Stylist selected:', stylist);
      // Prompt user to pick a date (do not fetch slots for today here)
      const days = getAvailableBookingDays();
      await sendWhatsAppList({
        phoneNumberId,
        to: from,
        header: `Choose a date for ${stylist}`,
        body: 'Please select a day for your appointment:',
        button: 'Select Day',
        rows: days
      });
      session.data.calendarDays = days;
      session.step = 'calendar_pick_day';
      res.status(200).end();
      return;
    } else {
      // Fallback: show stylist list again
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Please select a stylist from the list.'
      });
      session.step = 'choose_stylist';
      res.status(200).end();
      return;
    }
  }

  // Step 2B: Date Selection
  if (session.step === 'choose_date') {
    let date = '';
    if (userMsg === 'date_today') date = session.data.todayDate || 'Today';
    else if (userMsg === 'date_tomorrow') date = 'Tomorrow';
    else if (userMsg === 'date_calendar') {
      // Show next 7 days as options
      const days = getAvailableBookingDays();
      await sendWhatsAppList({
        phoneNumberId,
        to: from,
        header: 'Pick a date',
        body: 'Please select a day for your appointment:',
        button: 'Select Day',
        rows: days
      });
      session.data.calendarDays = days;
      session.step = 'calendar_pick_day';
      res.status(200).end();
      return;
    } else if (userMsg && userMsg.startsWith('calendar_day_')) {
      // User picked a calendar day
      const idx = parseInt(userMsg.replace('calendar_day_', ''), 10);
      const picked = session.data.calendarDays && session.data.calendarDays[idx] ? session.data.calendarDays[idx].title : '';
      if (picked) {
        date = picked;
      }
    } else if (userMsg === 'back_stylist') { session.step = 'choose_stylist'; await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res }); return; }
    // NEW: Accept free-text date label
    else if (session.data.calendarDays) {
      const match = session.data.calendarDays.find(day => day.title.toLowerCase() === userMsg.toLowerCase());
      if (match) {
        date = match.title;
      }
    }
    if (date) {
      session.data.date = date;
      let timeOptions = [];
      try {
        timeOptions = await fetchRealTimeSlots(date);
        if (!timeOptions.length) throw new Error('No available slots');
      } catch (err) {
        console.error('Error fetching real time slots:', err);
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: 'Sorry, we could not fetch available slots from our calendar. Please try again later.'
        });
        session.step = 'main_menu';
        res.status(200).end();
        return;
      }
      await sendSmartButtonsOrList({
        phoneNumberId,
        to: from,
        header: `Here are available time slots for ${session.data.stylist} on ${date}:`,
        body: 'Pick a time:',
        buttons: timeOptions.map((t, i) => ({ id: `slot_${i}`, title: `⏰ ${t}` })).concat([{ id: 'back_date', title: '🔙 Back' }])
      });
      session.data.timeMap = timeOptions;
      session.step = 'choose_time';
      res.status(200).end();
      return;
    } else if (!userMsg.startsWith('calendar_day_')) {
      // Fallback: show date options again
      session.step = 'choose_stylist';
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
      return;
    }
  }

  // Step 2B-2: Handle calendar day selection
  if (session.step === 'calendar_pick_day' || session.step === 'choose_date') {
    let date = '';
    // Handle id (e.g., calendar_day_2)
    if (userMsg && userMsg.startsWith('calendar_day_')) {
      const idx = parseInt(userMsg.replace('calendar_day_', ''), 10);
      const picked = session.data.calendarDays && session.data.calendarDays[idx] ? session.data.calendarDays[idx].title : '';
      if (picked) {
        date = picked;
      }
    }
    // Handle free-text (e.g., "Thursday 24 Jul")
    else if (session.data.calendarDays) {
      const match = session.data.calendarDays.find(day => day.title.toLowerCase() === userMsg.toLowerCase());
      if (match) {
        date = match.title;
      }
    }
    if (date) {
      session.data.date = date;
      let timeOptions = [];
      try {
        timeOptions = await fetchRealTimeSlots(date);
        if (!timeOptions.length) throw new Error('No available slots');
      } catch (err) {
        console.error('Error fetching real time slots:', err);
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: 'Sorry, we could not fetch available slots from our calendar. Please try again later.'
        });
        session.step = 'main_menu';
        res.status(200).end();
        return;
      }
      // Slot pagination
      const page = session.data.slotPage || 0;
      const pageSize = 10;
      const pagedSlots = timeOptions.slice(page * pageSize, (page + 1) * pageSize);
      let buttons = pagedSlots.map((t, i) => ({ id: `slot_${page * pageSize + i}`, title: `⏰ ${t}` }));
      if ((page + 1) * pageSize < timeOptions.length) {
        buttons.push({ id: 'slot_next', title: 'Next ⏭️' });
      }
      if (page > 0) {
        buttons.unshift({ id: 'slot_prev', title: '⏮️ Previous' });
      }
      buttons.push({ id: 'back_date', title: '🔙 Back' });
      await sendSmartButtonsOrList({
        phoneNumberId,
        to: from,
        header: `Here are available time slots for ${session.data.stylist} on ${date}:`,
        body: 'Pick a time:',
        buttons
      });
      session.data.timeMap = timeOptions;
      session.step = 'choose_time';
      res.status(200).end();
      return;
    } else {
      // Fallback: show calendar days again
      await sendWhatsAppList({
        phoneNumberId,
        to: from,
        header: 'Pick a date',
        body: 'Please select a day for your appointment:',
        button: 'Select Day',
        rows: session.data.calendarDays || []
      });
      session.step = 'calendar_pick_day';
      res.status(200).end();
      return;
    }
  }

  // Step 2C: Time Slot Selection
  if (session.step === 'choose_time') {
    let time = '';
    if (userMsg && userMsg.startsWith('slot_')) {
      if (userMsg === 'slot_next') {
        session.data.slotPage = (session.data.slotPage || 0) + 1;
        session.step = 'calendar_pick_day';
        await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
        return;
      } else if (userMsg === 'slot_prev') {
        session.data.slotPage = Math.max((session.data.slotPage || 0) - 1, 0);
        session.step = 'calendar_pick_day';
        await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
        return;
      } else {
        const idx = parseInt(userMsg.replace('slot_', ''), 10);
        time = session.data.timeMap && session.data.timeMap[idx] ? session.data.timeMap[idx] : '';
      }
    }
    else if (userMsg === 'back_date') { session.step = 'choose_date'; await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res }); return; }
    // NEW: Accept free-text time slot
    else if (session.data.timeMap) {
      const match = session.data.timeMap.find(t => t.toLowerCase() === userMsg.toLowerCase() || `⏰ ${t}`.toLowerCase() === userMsg.toLowerCase());
      if (match) {
        time = match;
      }
    }
    if (time) {
      session.data.time = time;
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: `Awesome! Booking you for *${time} with ${session.data.stylist}* on *${session.data.date}*\n\nCan I get your name please? 😊`
      });
      session.step = 'await_name_final';
      res.status(200).end();
      return;
    } else {
      // Fallback: show time slots again
      session.step = 'calendar_pick_day';
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
      return;
    }
  }

  // Step 2D: Name & Email
  if (session.step === 'await_name_final') {
    if (userMsgType === 'text' && userMsg.length > 1) {
      session.data.name = messages.text.body;
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: `Thanks, ${session.data.name}! What’s the best number to reach you at?`
      });
      session.step = 'await_number_final';
      res.status(200).end();
      return;
    } else {
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Please enter your name to continue.'
      });
      session.step = 'await_name_final';
      res.status(200).end();
      return;
    }
  }
  if (session.step === 'await_number_final') {
    if (userMsgType === 'text' && userMsg.length > 5) {
      session.data.phone = messages.text.body;
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: `Thanks! Lastly, your email? 📧 (Just for confirmation, no spam promise 🤞)`
      });
      session.step = 'await_email_final';
      res.status(200).end();
      return;
    } else {
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Please enter a valid phone number.'
      });
      session.step = 'await_number_final';
      res.status(200).end();
      return;
    }
  }
  if (session.step === 'await_email_final') {
    if (userMsgType === 'text' && userMsg.includes('@')) {
      session.data.email = messages.text.body;
      // Create Google Calendar event
      try {
        // Parse date and time to ISO
        const dateObj = new Date(session.data.date);
        let hour = 10, min = 0;
        const timeMatch = session.data.time.match(/(\d+):(\d+) (AM|PM)/i);
        if (timeMatch) {
          hour = parseInt(timeMatch[1], 10);
          min = parseInt(timeMatch[2], 10);
          if (timeMatch[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
          if (timeMatch[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
        }
        dateObj.setHours(hour, min, 0, 0);
        const startISO = new Date(dateObj).toISOString();
        const endISO = new Date(dateObj.getTime() + 60 * 60000).toISOString();
        await createEvent({
          summary: `Appointment: ${session.data.name} - ${session.data.chosenService} with ${session.data.stylist}`,
          description: `Name: ${session.data.name}\nPhone: ${session.data.phone}\nEmail: ${session.data.email}\nService: ${session.data.chosenService}\nStylist: ${session.data.stylist}\nDate: ${session.data.date}\nTime: ${session.data.time}\nBooked via WhatsApp`,
          start: startISO,
          end: endISO,
          attendees: [session.data.email],
          location: 'Your Business Address Here', // optional, replace with your address
          colorId: '2' // optional, see Google Calendar color docs
        });
        // Notify admins
        await notifyAdmins({
          phoneNumberId,
          message: `*New Booking*\nName: ${session.data.name}\nPhone: ${session.data.phone}\nEmail: ${session.data.email}\nService: ${session.data.chosenService}\nStylist: ${session.data.stylist}\nDate: ${session.data.date}\nTime: ${session.data.time}`
        });
      } catch (err) {
        console.error('Error creating Google Calendar event:', err);
      }
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: `🎉 You're all set, ${session.data.name}!\n\n📍 *Hair Rap by Yoyo*\n📅 *${session.data.date}*\n⏰ *${session.data.time}*\n✂️ *Stylist: ${session.data.stylist}*\n💇 *Service: ${session.data.chosenService}*\n📞 *Phone: ${session.data.phone}*\n📧 *Email: ${session.data.email}*\n\nWe’ll see you soon! 💖\nLocation: https://goo.gl/maps/xyz123\nNeed to reschedule or cancel? Just message me anytime!`
      });
      session.step = 'main_menu';
      res.status(200).end();
      return;
    } else {
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Please enter a valid email address to confirm your booking.'
      });
      session.step = 'await_email_final';
      res.status(200).end();
      return;
    }
  }

  // Step 3: FAQ/Ask a Question (AI-powered)
  if (session.step === 'faq_await') {
    // Handle 'Go to Home' button to reset to main menu
    if (userMsg === 'main_menu' || userMsg === 'go to home' || userMsg === '🏠 go to home' || userMsg === '🏠') {
      session.step = 'main_menu';
      await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
      return;
    }
    // Use OpenAI for FAQ
    const prompt = `You are a helpful, friendly, and stylish assistant for Hair Rap by Yoyo. Use the following knowledge base to answer user questions.\n\n[KNOWLEDGE BASE]\n${knowledgeBase}\n\n[USER]: ${messages.text?.body || userMsg}\n[ASSISTANT]:`;
    let aiResponse = '';
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        temperature: 0.3,
        messages: [
          { role: 'system', content: 'You are a helpful, friendly, and stylish assistant for Hair Rap by Yoyo.' },
          { role: 'user', content: prompt }
        ]
      });
      aiResponse = completion.choices[0].message.content.trim();
    } catch (err) {
      aiResponse = "Sorry, I'm having trouble accessing my info right now. Please try again later or use the menu.";
    }
    await sendSmartButtonsOrList({
      phoneNumberId,
      to: from,
      header: undefined,
      body: aiResponse,
      buttons: [
        { id: 'book_appt', title: '🗓️ Book Appointment' },
        { id: 'main_menu', title: '🏠 Go to Home' }
      ]
    });
    session.step = 'faq_await';
    res.status(200).end();
    return;
  }

  // Handle user query for human (do not show main menu again)
  if (session.step === 'await_human_query') {
    if (userMsgType === 'text' && userMsg.length > 1) {
      // Send WhatsApp message to all admin numbers
      const adminNumbers = ['919313045439', '919484607042', '916355411809'];
      for (const adminNumber of adminNumbers) {
        await sendWhatsAppText({
          phoneNumberId,
          to: adminNumber,
          body: `*Human Support Request*\nFrom: ${from}\nMessage: ${messages.text.body}`
        });
      }
      // Optionally, send email to staff (nodemailer integration placeholder)
      // await sendSupportEmail({ from, message: messages.text.body });
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Thank you! Your message has been sent to our team. A human will reach out to you soon.'
      });
      session.step = 'main_menu_waiting';
      res.status(200).end();
      return;
    } else {
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Please enter your query for our team.'
      });
      session.step = 'await_human_query';
      res.status(200).end();
      return;
    }
  }

  // Fallback for any other unexpected input (AI-powered)
  if (userMsgType === 'text') {
    const prompt = `You are a helpful, friendly, and stylish assistant for Hair Rap by Yoyo. Use the following knowledge base to answer user questions.\n\n[KNOWLEDGE BASE]\n${knowledgeBase}\n\n[USER]: ${messages.text?.body || userMsg}\n[ASSISTANT]:`;
    let aiResponse = '';
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        temperature: 0.3,
        messages: [
          { role: 'system', content: 'You are a helpful, friendly, and stylish assistant for Hair Rap by Yoyo.' },
          { role: 'user', content: prompt }
        ]
      });
      aiResponse = completion.choices[0].message.content.trim();
    } catch (err) {
      aiResponse = "Oops! I didn’t get that.\nYou can tap a button below or type:\n• Book\n• Price\n• Ask";
    }
    await sendSmartButtonsOrList({
      phoneNumberId,
      to: from,
      header: undefined,
      body: aiResponse,
      buttons: [
        { id: 'book_appt', title: '🗓️ Book Appointment' },
        { id: 'main_menu', title: '🏠 Go to Home' }
      ]
    });
    session.step = 'main_menu_waiting';
    res.status(200).end();
    return;
  }

  // === BEGIN: Re-inserted cancel/reschedule logic inside handler ===
  if (session.step === 'cancel_lookup') {
    const userInput = userMsgType === 'text' ? messages.text.body.trim() : '';
    if (userInput && userInput.includes('@')) {
      const today = new Date();
      const foundEvents = [];
      for (let offset = 0; offset < 30; offset++) {
        const date = new Date(today.getTime() + offset * 24 * 60 * 60 * 1000);
        const dateStr = date.toISOString().slice(0, 10);
        for (let hour = 9; hour < 23; hour++) {
          const timeStr = `${hour.toString().padStart(2, '0')}:00`;
          const result = await findEventByEmailAndTime({ email: userInput, date: dateStr, time: timeStr });
          if (result) {
            foundEvents.push({ eventId: result.eventId, summary: result.event.summary, date: dateStr, time: timeStr });
          }
        }
      }
      if (foundEvents.length === 1) {
        // Only one event found, proceed to confirmation
        const foundEvent = foundEvents[0];
        session.data.cancelEventId = foundEvent.eventId;
        session.data.cancelEventSummary = foundEvent.summary;
        session.data.cancelEventDate = foundEvent.date;
        session.data.cancelEventTime = foundEvent.time;
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: `Found your appointment:\n${foundEvent.summary}\nDate: ${foundEvent.date}\nTime: ${foundEvent.time}\nDo you want to cancel this appointment? Reply YES to confirm or NO to abort.`
        });
        session.step = 'cancel_confirm';
        res.status(200).end();
        return;
      } else if (foundEvents.length > 1) {
        // Multiple events found, let user pick
        session.data.cancelEventChoices = foundEvents;
        let msg = 'Multiple appointments found. Reply with the number to select:\n';
        foundEvents.forEach((ev, idx) => {
          msg += `${idx + 1}. ${ev.summary} on ${ev.date} at ${ev.time}\n`;
        });
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: msg
        });
        session.step = 'cancel_pick_event';
        res.status(200).end();
        return;
      } else {
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: 'No appointment found for this email. Please check and try again.'
        });
        session.step = 'main_menu';
        res.status(200).end();
        return;
      }
    } else {
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Please enter the email address you used for booking.'
      });
      session.step = 'cancel_lookup';
      res.status(200).end();
      return;
    }
  }
  if (session.step === 'cancel_pick_event') {
    // User should reply with a number
    const idx = parseInt(userMsg, 10) - 1;
    const choices = session.data.cancelEventChoices || [];
    if (!isNaN(idx) && choices[idx]) {
      const foundEvent = choices[idx];
      session.data.cancelEventId = foundEvent.eventId;
      session.data.cancelEventSummary = foundEvent.summary;
      session.data.cancelEventDate = foundEvent.date;
      session.data.cancelEventTime = foundEvent.time;
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: `You selected:\n${foundEvent.summary}\nDate: ${foundEvent.date}\nTime: ${foundEvent.time}\nDo you want to cancel this appointment? Reply YES to confirm or NO to abort.`
      });
      session.step = 'cancel_confirm';
      res.status(200).end();
      return;
    } else {
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Invalid selection. Please reply with the number of the appointment you want to cancel.'
      });
      session.step = 'cancel_pick_event';
      res.status(200).end();
      return;
    }
  }
  if (session.step === 'cancel_confirm') {
    if (userMsgType === 'text' && userMsg.trim().toLowerCase() === 'yes') {
      try {
        await deleteEvent(session.data.cancelEventId);
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: 'Your appointment has been cancelled and the slot is now free.'
        });
      } catch (err) {
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
      session.step = 'main_menu';
      res.status(200).end();
      return;
    } else {
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
      session.step = 'main_menu';
      res.status(200).end();
      return;
    }
  }
  if (session.step === 'reschedule_lookup') {
    const userInput = userMsgType === 'text' ? messages.text.body.trim() : '';
    if (userInput && userInput.includes('@')) {
      const today = new Date();
      const foundEvents = [];
      for (let offset = 0; offset < 30; offset++) {
        const date = new Date(today.getTime() + offset * 24 * 60 * 60 * 1000);
        const dateStr = date.toISOString().slice(0, 10);
        for (let hour = 9; hour < 23; hour++) {
          const timeStr = `${hour.toString().padStart(2, '0')}:00`;
          const result = await findEventByEmailAndTime({ email: userInput, date: dateStr, time: timeStr });
          if (result) {
            foundEvents.push({ eventId: result.eventId, summary: result.event.summary, date: dateStr, time: timeStr });
          }
        }
      }
      if (foundEvents.length === 1) {
        // Only one event found, proceed to confirmation
        const foundEvent = foundEvents[0];
        session.data.rescheduleEventId = foundEvent.eventId;
        session.data.rescheduleEventSummary = foundEvent.summary;
        session.data.rescheduleEventDate = foundEvent.date;
        session.data.rescheduleEventTime = foundEvent.time;
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: `Found your appointment:\n${foundEvent.summary}\nDate: ${foundEvent.date}\nTime: ${foundEvent.time}\nDo you want to reschedule this appointment? Reply YES to confirm or NO to abort.`
        });
        session.step = 'reschedule_confirm';
        res.status(200).end();
        return;
      } else if (foundEvents.length > 1) {
        // Multiple events found, let user pick
        session.data.rescheduleEventChoices = foundEvents;
        let msg = 'Multiple appointments found. Reply with the number to select:\n';
        foundEvents.forEach((ev, idx) => {
          msg += `${idx + 1}. ${ev.summary} on ${ev.date} at ${ev.time}\n`;
        });
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: msg
        });
        session.step = 'reschedule_pick_event';
        res.status(200).end();
        return;
      } else {
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: 'No appointment found for this email. Please check and try again.'
        });
        session.step = 'main_menu';
        res.status(200).end();
        return;
      }
    } else {
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Please enter the email address you used for booking.'
      });
      session.step = 'reschedule_lookup';
      res.status(200).end();
      return;
    }
  }
  if (session.step === 'reschedule_pick_event') {
    // User should reply with a number
    const idx = parseInt(userMsg, 10) - 1;
    const choices = session.data.rescheduleEventChoices || [];
    if (!isNaN(idx) && choices[idx]) {
      const foundEvent = choices[idx];
      session.data.rescheduleEventId = foundEvent.eventId;
      session.data.rescheduleEventSummary = foundEvent.summary;
      session.data.rescheduleEventDate = foundEvent.date;
      session.data.rescheduleEventTime = foundEvent.time;
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: `You selected:\n${foundEvent.summary}\nDate: ${foundEvent.date}\nTime: ${foundEvent.time}\nDo you want to reschedule this appointment? Reply YES to confirm or NO to abort.`
      });
      session.step = 'reschedule_confirm';
      res.status(200).end();
      return;
    } else {
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Invalid selection. Please reply with the number of the appointment you want to reschedule.'
      });
      session.step = 'reschedule_pick_event';
      res.status(200).end();
      return;
    }
  }
  if (session.step === 'reschedule_confirm') {
    if (userMsgType === 'text' && userMsg.trim().toLowerCase() === 'yes') {
      try {
        await deleteEvent(session.data.rescheduleEventId);
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: 'Your previous appointment has been cancelled. Let’s book a new one!'
        });
        // Reset session data
        session.data.rescheduleEventId = undefined;
        session.data.rescheduleEventSummary = undefined;
        session.data.rescheduleEventDate = undefined;
        session.data.rescheduleEventTime = undefined;
        session.data.rescheduleEventChoices = undefined;
        // Start booking flow from service selection
        session.step = 'choose_service';
        res.status(200).end();
        return;
      } catch (err) {
        await sendWhatsAppText({
          phoneNumberId,
          to: from,
          body: 'There was an error rescheduling your appointment. Please try again or contact support.'
        });
        session.step = 'main_menu';
        res.status(200).end();
        return;
      }
    } else {
      await sendWhatsAppText({
        phoneNumberId,
        to: from,
        body: 'Reschedule aborted. Your appointment is still active.'
      });
      session.data.rescheduleEventId = undefined;
      session.data.rescheduleEventSummary = undefined;
      session.data.rescheduleEventDate = undefined;
      session.data.rescheduleEventTime = undefined;
      session.data.rescheduleEventChoices = undefined;
      session.step = 'main_menu';
      res.status(200).end();
      return;
    }
  }
  // === END: Re-inserted cancel/reschedule logic inside handler ===

  // Fallback: always show main menu
  session.step = 'main_menu';
  await handleUserChatbotFlow({ from, phoneNumberId, messages: { type: 'trigger' }, res });
  return;
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
    console.log('Incoming WhatsApp message:', JSON.stringify(messages, null, 2));

    // Admin logic: if from admin number, use Step1.js flow
    if (from === '919313045438' || from === '+919313045438' || from === '916355411808' || from === '+916355411808') {
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
      console.log('User logic (CODE CLINIC flow) triggered for', from);
      await handleUserChatbotFlow({ from, phoneNumberId, messages, res });
      return;
    }
  } catch (err) {
    console.error('Error extracting data from webhook payload:', err);
  }
  res.status(200).end();
});

// Helper: send admin notification
async function notifyAdmins({ phoneNumberId, message }) {
  const adminNumbers = ['919313045439', '919484607042', '916355411809'];
  for (const adminNumber of adminNumbers) {
    await sendWhatsAppText({
      phoneNumberId,
      to: adminNumber,
      body: message
    });
  }
}

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
