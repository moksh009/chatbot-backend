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

async function sendWhatsAppImage({ phoneNumberId, to, imageLink, caption, token, io, clientId }) {
  const apiVersion = process.env.API_VERSION || 'v18.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: {
      link: imageLink,
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
    await saveAndEmitMessage({ phoneNumberId, to, body: `[Image Sent]: ${caption}`, type: 'image', io, clientId });
  } catch (err) {
    console.error('Error sending WhatsApp image:', err.response?.data || err.message);
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

// ===================================================================
// HELPERS: date/time parsing + calendar slot validation + auto-booking
// ===================================================================

/**
 * Converts a natural-language or form date string to YYYY-MM-DD.
 * Handles: 'tomorrow', 'today', 'YYYY-MM-DD', 'DD/MM/YYYY', 'Monday, 27 Feb 2026'
 */
function resolveBookingDate(dateStr) {
  if (!dateStr || dateStr === 'TBD') return null;
  const ist = DateTime.now().setZone('Asia/Kolkata');
  const lower = dateStr.trim().toLowerCase();
  if (lower === 'today') return ist.toFormat('yyyy-MM-dd');
  if (lower === 'tomorrow') return ist.plus({ days: 1 }).toFormat('yyyy-MM-dd');
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) return dateStr.trim();
  // DD/MM/YYYY
  const dmY = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmY) return `${dmY[3]}-${dmY[2].padStart(2, '0')}-${dmY[1].padStart(2, '0')}`;
  // Try luxon parse of human-readable formats (e.g. "Monday, 27 Feb 2026")
  const formats = ['EEEE, dd MMM yyyy', 'dd MMM yyyy', 'dd MMM', 'EEEE dd MMM'];
  for (const fmt of formats) {
    const parsed = DateTime.fromFormat(dateStr.trim(), fmt, { locale: 'en', zone: 'Asia/Kolkata' });
    if (parsed.isValid) {
      const result = parsed.year < 2000 ? parsed.set({ year: ist.year }) : parsed;
      return result.toFormat('yyyy-MM-dd');
    }
  }
  // Last resort: JS Date
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch { }
  console.warn(`[TURF] Could not parse date: ${dateStr}`);
  return null;
}

/**
 * Converts any time format to 24h "HH:MM" string.
 * Handles: '7pm', '7:00 PM', '19:00', '7 PM', '7:30pm', '5pm - 6pm'
 */
function parseTimeToHHMM(timeStr) {
  if (!timeStr || timeStr === 'TBD') return null;
  let t = timeStr.trim();

  // Handle ranges like '5pm - 6pm' or '5 to 7pm' by taking the first time
  const parts = t.split(/[-]| to /i).map(s => s.trim());
  if (parts.length > 1) {
    if (!/(am|pm)$/i.test(parts[0]) && /(am|pm)$/i.test(parts[1])) {
      parts[0] += parts[1].match(/(am|pm)$/i)[1];
    }
    t = parts[0];
  }

  // Already HH:MM 24h
  if (/^\d{2}:\d{2}$/.test(t)) return t;
  // HH:MM AM/PM or H am/pm
  const match = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (match) {
    let h = parseInt(match[1], 10);
    const m = match[2] ? parseInt(match[2], 10) : 0;
    const period = match[3].toLowerCase();
    if (period === 'pm' && h !== 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Resolves a turf arena name to its Google Calendar ID.
 * Tries exact match, then lowercase+underscore key match.
 */
function resolveCalendarId(arenaName, calendars) {
  if (!arenaName || !calendars || Object.keys(calendars).length === 0) return null;
  if (calendars[arenaName]) return calendars[arenaName];
  const key = arenaName.toLowerCase().replace(/\s+/g, '_');
  if (calendars[key]) return calendars[key];
  // Use the first calendar if there's only one configured
  const keys = Object.keys(calendars);
  if (keys.length === 1) return calendars[keys[0]];
  return null;
}

/**
 * Checks if a specific 1-hour slot is free on Google Calendar.
 * If free  → creates the event and returns { booked: true, eventId }.
 * If taken → returns { booked: false, availableSlots: ['10:00', '11:00', ...] }.
 */
async function attemptCalendarBooking({ calendarId, isoDate, timeHHMM, captain_name, chosenService, from, revenue, turf_arena, clientId }) {
  const { listEvents, createEvent, getAvailableTimeSlots } = require('../../utils/googleCalendar');

  const slotStart = new Date(`${isoDate}T${timeHHMM}:00+05:30`);
  const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);

  console.log(`[TURF] Checking slot: ${isoDate} ${timeHHMM} — calendar: ${calendarId}`);

  let existingEvents = [];
  try {
    existingEvents = await listEvents(slotStart.toISOString(), slotEnd.toISOString(), calendarId);
  } catch (e) {
    console.error('[TURF] listEvents error (will try booking anyway):', e.message);
  }

  const isSlotFree = existingEvents.length === 0;
  console.log(`[TURF] Slot ${timeHHMM} on ${isoDate}: ${isSlotFree ? '✅ FREE' : `❌ TAKEN (${existingEvents.length} events)`}`);

  if (isSlotFree) {
    try {
      const eventResult = await createEvent({
        calendarId,
        summary: `⚽ ${captain_name} — ${chosenService}`,
        description: `Name: ${captain_name}\nPhone: ${from}\nService: ${chosenService}\nArena: ${turf_arena}\nFee: ₹${revenue}`,
        start: slotStart.toISOString(),
        end: slotEnd.toISOString()
      });
      console.log(`[TURF] ✅ Calendar event created: ${eventResult.eventId}`);
      return { booked: true, eventId: eventResult.eventId };
    } catch (e) {
      console.error('[TURF] createEvent failed (still treating as booked):', e.message);
      return { booked: true, eventId: null };
    }
  } else {
    // Fetch remaining available slots for the day
    let availableSlots = [];
    try {
      const slotsResult = await getAvailableTimeSlots({
        date: isoDate,
        startTime: '09:00',
        endTime: '23:00',
        slotMinutes: 60,
        calendarId,
        capacity: 1
      });
      availableSlots = slotsResult.map(s => {
        const dt = new Date(s.start);
        const h = String(dt.getUTCHours() + 5).padStart(2, '0');
        const m = dt.getUTCMinutes() + 30;
        // Handle IST offset properly with luxon
        const ist = DateTime.fromISO(s.start, { zone: 'UTC' }).setZone('Asia/Kolkata');
        return ist.toFormat('HH:mm');
      });
    } catch (e) {
      console.error('[TURF] getAvailableTimeSlots error:', e.message);
    }
    return { booked: false, availableSlots };
  }
}

// --- Main Flow Handler ---

async function handleUserChatbotFlow({ from, phoneNumberId, messages, res, clientConfig, io }) {
  const session = getUserSession(from);
  const userMsgType = messages.type;
  const userMsg = userMsgType === 'interactive' ? (messages.interactive?.button_reply?.id || messages.interactive?.list_reply?.id) : messages.text?.body;

  const { whatsappToken: token, geminiApiKey, config, clientId } = clientConfig;
  const calendars = config.calendars || {};
  const adminNumbers = config.adminPhones || (config.adminPhone ? [config.adminPhone] : []);
  // Resolve Flow ID: MongoDB config.flowId takes priority, then env, then hardcoded default
  const TURF_FLOW_ID = config.flowId || process.env.WHATSAPP_FLOW_ID || '2043223316539716';

  // Use the already-trimmed key resolved by clientConfig middleware
  const resolvedGeminiKey = geminiApiKey || process.env.GEMINI_API_KEY?.trim();
  console.log(`[TURF] Gemini key source: ${geminiApiKey ? 'DB/Middleware' : 'Env Fallback'}, len=${resolvedGeminiKey?.length || 0}`);
  if (!resolvedGeminiKey) console.warn('[TURF] ⚠️ No Gemini API key found! AI replies will fail.');
  const genAI = new GoogleGenerativeAI(resolvedGeminiKey || 'MISSING_KEY');

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
      session.data.date = date; // initially just the raw YYYY-MM-DD
      session.data.time = time;
      session.data.name = captain_name;
      session.data.revenue = calculatePricing(time).price;

      // 1) RESOLVE DATE AND TIME
      const isoDate = resolveBookingDate(date);
      const timeHHMM = parseTimeToHHMM(time);
      const calendarId = resolveCalendarId(turf_arena, calendars);

      // 2) PRE-EMPTIVELY CHECK AVAILABILITY BEFORE ASKING TO CONFIRM
      if (calendarId && isoDate && timeHHMM) {
        let existingEvents = [];
        try {
          const slotStart = new Date(`${isoDate}T${timeHHMM}:00+05:30`);
          const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
          const { listEvents } = require('../../utils/googleCalendar');
          existingEvents = await listEvents(slotStart.toISOString(), slotEnd.toISOString(), calendarId);
        } catch (e) {
          console.error('[TURF] pre-check listEvents error:', e.message);
        }

        // IF THE SLOT IS ALREADY TAKEN (Duplicate booking intercepted early!)
        if (existingEvents.length > 0) {
          console.log(`[TURF] Slot ${timeHHMM} on ${isoDate} is TAKEN. Triggering fallback.`);

          // Re-format YYYY-MM-DD to 'EEEE, dd MMM yyyy' for fetchRealTimeSlots
          const formattedDate = DateTime.fromISO(isoDate, { zone: 'Asia/Kolkata' }).toFormat('EEEE, dd MMM yyyy');
          const slotsData = await fetchRealTimeSlots(formattedDate, 0, turf_arena, calendars);

          if (slotsData.slots.length === 0) {
            await sendWhatsAppButtons({
              phoneNumberId, to: from, token, io, clientId,
              body: `⚠️ Oops! The time slot *${time}* has already been booked and no other slots are available on *${date}*.`,
              buttons: [
                { id: 'user_schedule_appt', title: 'Try Another Date ⚽' },
                { id: 'user_home', title: 'Main Menu 🏠' }
              ]
            });
          } else {
            session.step = 'pick_available_slot';
            const rows = slotsData.slots.map(s => {
              const p = calculatePricing(s);
              return { id: `avail_slot_${s}`, title: s, description: `₹${p.price}/hr — ${p.label}` };
            });

            const slotTextList = slotsData.slots.map(s => {
              const displayTime = DateTime.fromFormat(s, 'HH:mm', { zone: 'Asia/Kolkata' }).toFormat('h:mm a');
              const displayEndTime = DateTime.fromFormat(s, 'HH:mm', { zone: 'Asia/Kolkata' }).plus({ hours: 1 }).toFormat('h:mm a');
              return `• ${displayTime} - ${displayEndTime}`;
            }).join('\n');

            await sendWhatsAppText({
              phoneNumberId, to: from, token, io, clientId,
              body: `⚠️ *${time}* is already booked!\n\nHere are the available time slots for ${date}:\n${slotTextList}\n\nYou can *choose from the menu below* OR *type your time* (e.g. "5pm - 6pm" or "5pm").`
            });

            await sendWhatsAppList({
              phoneNumberId, to: from, token, io, clientId,
              header: `⚠️ Time slot taken!`,
              body: `Please select another time to confirm your booking instantly:`,
              footer: 'Dynamic pricing applies ⚽', button: 'Choose Slot', rows
            });
          }
          return res.status(200).end();
        }
      }

      // 3) IF SLOT IS FREE (OR NO CALENDAR ID), ASK FOR CONFIRMATION
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

  // Upsells have been removed post-booking due to unneeded complexity.
  // We strictly keep the share squad action logic underneath.

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

      const shareMsg = `🏆 *MATCH CONFIRMED* ⚽\n\n🏟️ *Arena:* ${lastAppt.doctor || 'Rough N Turf'}\n📅 *Date:* ${lastAppt.date}\n🕒 *Time:* ${lastAppt.time}\n⚽ *Format:* ${lastAppt.service.includes('8v8') ? '8v8 Football' : lastAppt.service.includes('Pickleball') ? 'Pickleball' : '5v5 Football'}\n\n👤 *Captain:* ${lastAppt.name}\n\n💰 *Total Pitch Fee:* ₹${lastAppt.revenue}\n🧑‍🤝‍🧑 *Split per player:* ₹${splitPrice} (for ${totalPlayers} players)\n\n📍 *Pay via UPI to the captain to lock your spot!*`;

      await sendWhatsAppText({ phoneNumberId, to: from, token, io, clientId, body: `Here is the squad detail message. Copy and forward this to your WhatsApp group! 👇` });
      await sendWhatsAppImage({ phoneNumberId, to: from, token, io, clientId, imageLink: TURF_LOGO, caption: shareMsg });
    }
    res.status(200).end();
    return;
  }

  // If user sends a greeting, always show the main menu WhatsApp List
  const msgLower = (userMsgType === 'text' && userMsg) ? userMsg.trim().toLowerCase() : '';
  const isGreeting = msgLower && GREETING_WORDS.some(w =>
    msgLower === w || msgLower.startsWith(w + ' ') || msgLower.startsWith(w + ',') || msgLower.startsWith(w + '!') || msgLower.startsWith(w + '.')
  );
  if (isGreeting && session.step !== 'appt_name') {
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
  // ===================================================================
  // NEW: Handle user picking a slot from the "available slots" list
  // (Fires when nfm_reply or AI detected that the requested slot was taken)
  // ===================================================================
  if (session.step === 'pick_available_slot') {
    let chosenTime = null;
    if (userMsg && userMsg.startsWith('avail_slot_')) {
      chosenTime = userMsg.replace('avail_slot_', '');
    } else if (userMsgType === 'text') {
      const parsed = parseTimeToHHMM(userMsg);
      if (parsed) chosenTime = parsed;
    }

    if (chosenTime) {
      const { chosenService, doctor, dateStr, date: isoDate, name, revenue: prevRevenue } = session.data;
      const calendarId = resolveCalendarId(doctor, calendars);
      const newRevenue = calculatePricing(chosenTime).price;

      const bookingResult = calendarId
        ? await attemptCalendarBooking({ calendarId, isoDate, timeHHMM: chosenTime, captain_name: name, chosenService, from, revenue: newRevenue, turf_arena: doctor, clientId })
        : { booked: true, eventId: null }; // no cal config → optimistic

      if (bookingResult.booked) {
        // Display time in 12h for user
        const displayTime = DateTime.fromFormat(chosenTime, 'HH:mm', { zone: 'Asia/Kolkata' }).toFormat('h:mm a');
        await Appointment.create({
          clientId, phone: from, name, service: chosenService,
          date: dateStr, time: displayTime, status: 'confirmed',
          revenue: newRevenue, doctor, eventId: bookingResult.eventId || undefined
        });
        await notifyAdmins({
          phoneNumberId, token, adminNumbers, io, clientId,
          message: `🏆 *New Rough N Turf Booking*\n\n👤 *Captain:* ${name}\n📅 *Date:* ${dateStr}\n🕒 *Time:* ${displayTime}\n🏟️ *Arena:* ${doctor}\n💰 *Revenue:* ₹${newRevenue}`
        });
        await sendWhatsAppButtons({
          phoneNumberId, to: from, token, io, clientId,
          imageHeader: TURF_LOGO,
          body: `✅ *Booking Confirmed!* ⚽🏆\n\n👤 *Captain:* ${name}\n⚽ *Sport:* ${chosenService}\n🏟️ *Arena:* ${doctor}\n📅 *Date:* ${dateStr}\n🕒 *Time:* ${displayTime}\n💳 *Fee:* ₹${newRevenue}`,
          buttons: [
            { id: 'action_share_squad', title: 'Share with Squad 📲' },
            { id: 'user_home', title: 'Main Menu 🏠' }
          ]
        });
        delete userSessions[from];
      } else {
        // Still taken — re-show updated slots
        const slots = bookingResult.availableSlots || [];
        if (slots.length === 0) {
          await sendWhatsAppButtons({
            phoneNumberId, to: from, token, io, clientId,
            body: `⚠️ That slot just got taken too! Unfortunately no more slots are available on *${dateStr}*.`,
            buttons: [
              { id: 'user_schedule_appt', title: 'Try Another Date ⚽' },
              { id: 'user_home', title: 'Main Menu 🏠' }
            ]
          });
        } else {
          const rows = slots.map(s => {
            const p = calculatePricing(s);
            return { id: `avail_slot_${s}`, title: s, description: `₹${p.price}/hr — ${p.label}` };
          });
          await sendWhatsAppList({
            phoneNumberId, to: from, token, io, clientId,
            header: '⚠️ That slot was just taken!',
            body: `Sorry, that slot at *${doctor}* on *${dateStr}* just got booked. Here are the remaining available slots:`,
            button: 'Choose Slot',
            rows
          });
        }
      }
      return res.status(200).end();
    }
  }

  if (session.step === 'appt_consent') {
    if (userMsg === 'confirm_booking') {
      try {
        const revenue = session.data.revenue || 3500;

        // Create appointment in DB
        await Appointment.create({
          clientId, phone: from, name: session.data.name,
          service: session.data.chosenService,
          date: session.data.dateStr || session.data.date,
          time: session.data.time, status: 'confirmed',
          revenue, doctor: session.data.doctor
        });

        // Create event in Google Calendar — uses correct param names: start/end
        try {
          const calendarId = resolveCalendarId(session.data.doctor, calendars);
          if (calendarId) {
            const isoDate = resolveBookingDate(session.data.dateStr || session.data.date);
            const timeHHMM = parseTimeToHHMM(session.data.time) || session.data.time.split(':').slice(0, 2).join(':');
            const slotStart = isoDate
              ? new Date(`${isoDate}T${timeHHMM}:00+05:30`)
              : new Date();
            const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
            await createEvent({
              calendarId,
              summary: `⚽ ${session.data.name} — ${session.data.chosenService}`,
              description: `Name: ${session.data.name}\nPhone: ${from}\nService: ${session.data.chosenService}\nArena: ${session.data.doctor}\nFee: ₹${revenue}`,
              start: slotStart.toISOString(),
              end: slotEnd.toISOString()
            });
            console.log(`[TURF] ✅ Google Calendar event created for ${session.data.doctor}`);
          } else {
            console.warn(`[TURF] ⚠️ No calendarId found for turf: ${session.data.doctor}`);
          }
        } catch (calErr) {
          // Calendar error should NOT block booking confirmation
          console.error('[TURF] Google Calendar createEvent error:', calErr.message);
        }

        // Notify Admin
        await notifyAdmins({
          phoneNumberId,
          message: `🏆 *New Rough N Turf Booking*\n\n👤 *Captain:* ${session.data.name}\n📅 *Date:* ${session.data.dateStr || session.data.date}\n🕒 *Time:* ${session.data.time}\n🏟️ *Arena:* ${session.data.doctor}\n💰 *Revenue:* ₹${revenue}`,
          token,
          adminNumbers, io, clientId
        });

        // Immediate Rough N Turf Upsell Trigger removed; show simplified Share Squad
        await sendWhatsAppButtons({
          phoneNumberId, to: from, token, io, clientId,
          imageHeader: TURF_LOGO,
          body: `✅ *Booking Confirmed!* We have reserved ${session.data.doctor} for you at ${session.data.time}.\n\nShare this with your squad!`,
          buttons: [
            { id: 'action_share_squad', title: 'Share with Squad 📲' },
            { id: 'user_home', title: 'Main Menu 🏠' }
          ]
        });

      } catch (e) {
        if (e.code === 11000) {
          console.error('Duplicate Booking Error:', e.message);

          // Re-format YYYY-MM-DD to 'EEEE, dd MMM yyyy' for fetchRealTimeSlots
          let formattedDateForSearch = session.data.dateStr || session.data.date;
          if (/^\d{4}-\d{2}-\d{2}$/.test(formattedDateForSearch)) {
            formattedDateForSearch = DateTime.fromISO(formattedDateForSearch, { zone: 'Asia/Kolkata' }).toFormat('EEEE, dd MMM yyyy');
          }

          const slotsData = await fetchRealTimeSlots(formattedDateForSearch, 0, session.data.doctor, calendars);

          if (slotsData.slots.length === 0) {
            await sendWhatsAppButtons({
              phoneNumberId, to: from, token, io, clientId,
              body: `⚠️ Oops! The time slot *${session.data.time}* just got booked and there are no other slots available on *${session.data.dateStr || session.data.date}*. Try another date?`,
              buttons: [
                { id: 'user_schedule_appt', title: 'Try Another Date ⚽' },
                { id: 'user_home', title: 'Main Menu 🏠' }
              ]
            });
          } else {
            session.step = 'pick_available_slot';
            const rows = slotsData.slots.map(s => {
              const displayTime = DateTime.fromFormat(s, 'HH:mm', { zone: 'Asia/Kolkata' }).toFormat('h:mm a');
              const displayEndTime = DateTime.fromFormat(s, 'HH:mm', { zone: 'Asia/Kolkata' }).plus({ hours: 1 }).toFormat('h:mm a');
              return { id: `avail_slot_${s}`, title: s, description: `${displayTime} - ${displayEndTime}` };
            });

            const slotTextList = slotsData.slots.map(s => {
              const displayTime = DateTime.fromFormat(s, 'HH:mm', { zone: 'Asia/Kolkata' }).toFormat('h:mm a');
              const displayEndTime = DateTime.fromFormat(s, 'HH:mm', { zone: 'Asia/Kolkata' }).plus({ hours: 1 }).toFormat('h:mm a');
              return `• ${displayTime} - ${displayEndTime}`;
            }).join('\n');

            await sendWhatsAppText({
              phoneNumberId, to: from, token, io, clientId,
              body: `⚠️ Someone just booked *${session.data.time}* before you!\n\nDon't worry, here are the available time slots for today:\n${slotTextList}\n\nYou can *choose from the menu below* OR *type your time* (e.g. "5pm - 6pm" or "5pm").`
            });

            // Make sure the action name exactly strictly evaluates correctly for the list builder
            await sendWhatsAppList({
              phoneNumberId, to: from, token, io, clientId,
              header: `⚠️ Time slot taken!`,
              body: `Please select another time to confirm your booking instantly:`,
              footer: 'Dynamic pricing applies ⚽', button: 'Choose Slot', rows
            });
          }
          return res.status(200).end();
        }

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
        // Use gemini-1.5-flash (correct name)
        let model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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

      let rawReply = '';
      try {
        // Use gemini-1.5-flash with a fallback to gemini-pro to prevent 404/500 errors
        let model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        let result;
        try {
          result = await model.generateContent(smartPrompt);
        } catch (apiErr) {
          console.error('[TURF] Flash AI failed, falling back to Pro:', apiErr.message);
          model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
          result = await model.generateContent(smartPrompt);
        }
        
        rawReply = result.response.text().trim();
      } catch (geminiNetErr) {
        console.error('Gemini API Network/Timeout Error (turf):', geminiNetErr.message);
        rawReply = "{}"; // Trigger the JSON parse fallback behavior
      }

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
        // AI extracted all 5 details — validate slot & auto-book
        const serviceMap = {
          'football (5v5)': 'Football Booking (5v5)',
          'football (8v8)': 'Football Booking (8v8)',
          'box cricket': 'Box Cricket',
          'pickleball': 'Pickleball Court'
        };
        const normalizedSport = extracted.sport ? (serviceMap[extracted.sport.toLowerCase()] || extracted.sport) : 'Turf Booking';
        const arena = extracted.turf_arena || Object.keys(calendars)[0] || 'Standard';
        const captainName = extracted.captain_name || 'Captain';
        const dateStr = extracted.date || 'TBD';
        const timeStr = extracted.time || 'TBD';
        const isoDate = resolveBookingDate(dateStr);
        const timeHHMM = parseTimeToHHMM(timeStr);
        const calendarId = resolveCalendarId(arena, calendars);
        const revenue = calculatePricing(timeHHMM || '17:00').price;

        // Send reply message first
        await sendWhatsAppText({ phoneNumberId, to: from, body: replyMsg, token, io, clientId });

        if (calendarId && isoDate && timeHHMM) {
          const bookingResult = await attemptCalendarBooking({
            calendarId, isoDate, timeHHMM, captain_name: captainName,
            chosenService: normalizedSport, from, revenue, turf_arena: arena, clientId
          });

          if (bookingResult.booked) {
            await Appointment.create({
              clientId, phone: from, name: captainName, service: normalizedSport,
              date: dateStr, time: timeStr, status: 'confirmed', revenue, doctor: arena,
              eventId: bookingResult.eventId || undefined
            });
            await notifyAdmins({
              phoneNumberId, token, adminNumbers, io, clientId,
              message: `🏆 *New Rough N Turf Booking*\n\n👤 *Captain:* ${captainName}\n📅 *Date:* ${dateStr}\n🕒 *Time:* ${timeStr}\n🏟️ *Arena:* ${arena}\n💰 *Revenue:* ₹${revenue}`
            });
            await sendWhatsAppButtons({
              phoneNumberId, to: from, token, io, clientId,
              imageHeader: TURF_LOGO,
              body: `✅ *Booking Confirmed!* ⚽🏆\n\n👤 *Captain:* ${captainName}\n⚽ *Sport:* ${normalizedSport}\n🏟️ *Arena:* ${arena}\n📅 *Date:* ${dateStr}\n🕒 *Time:* ${timeStr}\n💳 *Fee:* ₹${revenue}`,
              buttons: [
                { id: 'action_share_squad', title: 'Share with Squad 📲' },
                { id: 'user_home', title: 'Main Menu 🏠' }
              ]
            });
            delete userSessions[from];
          } else {
            const slots = bookingResult.availableSlots || [];
            if (slots.length === 0) {
              await sendWhatsAppButtons({
                phoneNumberId, to: from, token, io, clientId,
                body: `⚠️ Sorry! *${timeStr}* at *${arena}* on *${dateStr}* is fully booked and there are no other slots that day. Try a different date?`,
                buttons: [
                  { id: 'user_schedule_appt', title: 'Try Another Date ⚽' },
                  { id: 'user_home', title: 'Main Menu 🏠' }
                ]
              });
            } else {
              session.data = { chosenService: normalizedSport, doctor: arena, dateStr, date: isoDate, name: captainName, revenue };
              session.step = 'pick_available_slot';
              const rows = slots.map(s => {
                const p = calculatePricing(s);
                return { id: `avail_slot_${s}`, title: s, description: `₹${p.price}/hr — ${p.label}` };
              });
              await sendWhatsAppList({
                phoneNumberId, to: from, token, io, clientId,
                header: `⚠️ ${timeStr} is already booked!`,
                body: `Sorry, *${timeStr}* at *${arena}* on *${dateStr}* is taken. Here are available slots — tap one to book instantly:`,
                footer: 'Dynamic pricing applies ⚽', button: 'Choose Slot', rows
              });
            }
          }
        } else {
          // Can't validate — fall back to manual confirm buttons
          session.data = { chosenService: normalizedSport, doctor: arena, dateStr, date: dateStr, time: timeStr, name: captainName, revenue };
          session.step = 'appt_consent';
          await sendWhatsAppButtons({
            phoneNumberId, to: from, token, io, clientId,
            imageHeader: TURF_LOGO,
            body: `🥅 *Quick Booking Summary* 🥅\n\n👤 *Captain:* ${captainName}\n⚽ *Sport:* ${normalizedSport}\n🏟️ *Arena:* ${arena}\n📅 *Date:* ${dateStr}\n🕒 *Time:* ${timeStr}\n💳 *Estimated Fee:* ₹${revenue}\n\n_Confirm your reservation below!_`,
            buttons: [
              { id: 'confirm_booking', title: 'Confirm Booking ✅' },
              { id: 'cancel_booking', title: 'Cancel ❌' }
            ]
          });
        }
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
    const { whatsappToken, config, clientId, geminiApiKey } = req.clientConfig;
    const token = whatsappToken || process.env.WHATSAPP_TOKEN;

    let conversation = await Conversation.findOne({ phone: messages.from, clientId });
    if (!conversation) {
      conversation = await Conversation.create({
        phone: messages.from,
        clientId,
        status: 'BOT_ACTIVE',
        lastMessageAt: new Date()
      });
    }

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

    conversation.lastMessage = userMsgContent;
    conversation.lastMessageAt = new Date();
    if (conversation.status === 'HUMAN_TAKEOVER') {
      conversation.unreadCount = (conversation.unreadCount || 0) + 1;
    }
    await conversation.save();

    if (io) {
      io.to(`client_${clientId}`).emit('new_message', {
        clientId,
        from: messages.from,
        content: userMsgContent,
        direction: 'incoming'
      });
      io.to(`client_${clientId}`).emit('conversation_update', conversation);
    }

    if (conversation.status === 'HUMAN_TAKEOVER') {
      console.log(`[TURF] Conversation ${conversation._id} is in HUMAN_TAKEOVER mode. Skipping bot reply.`);
      return res.status(200).end();
    }

    await handleUserChatbotFlow({ from: messages.from, phoneNumberId: value.metadata.phone_number_id, messages, res, clientConfig: req.clientConfig, io });

  } catch (err) {
    console.error('Webhook Error:', err.message);
    res.status(200).end();
  }
};

module.exports = router;
module.exports.handleWebhook = exports.handleWebhook;
