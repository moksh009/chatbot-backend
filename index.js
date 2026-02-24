const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./db');
const Appointment = require('./models/Appointment');
const DailyStat = require('./models/DailyStat');
const Client = require('./models/Client');
const BirthdayUser = require('./models/BirthdayUser');
const cron = require('node-cron');
const { DateTime } = require('luxon');
// Load birthday data
const birthdayData = require('./birthdays.json');
const { sendBirthdayWishWithImage } = require('./utils/sendBirthdayMessage');
const scheduleAbandonedCartCron = require('./cron/abandonedCartScheduler');
// Load environment variables
// dotenv.config();
// Silence .env missing warning
const dotenvResult = dotenv.config();
if (dotenvResult.error && dotenvResult.error.code !== 'ENOENT') {
  console.error("Dotenv Error:", dotenvResult.error);
}
// If ENOENT, it just means no file, which is fine if envs are injected otherwise.


const cors = require('cors');
const authRoutes = require('./routes/auth');
const conversationRoutes = require('./routes/conversations');
const appointmentRoutes = require('./routes/appointments');
const analyticsRoutes = require('./routes/analytics');
const campaignsRoutes = require('./routes/campaigns');
// const turfClientRoutes = require('./routes/clientcodes/turf'); // Deprecated in favor of dynamic router
// const vedClientRoutes = require('./routes/clientcodes/ved');   // Deprecated in favor of dynamic router
const dynamicClientRouter = require('./routes/dynamicClientRouter');
const trackingRoutes = require('./routes/tracking.js');

const app = express();
const PORT = process.env.PORT || 3000;

// WhatsApp Cloud API env validation (hard fail if missing)
function resolveWhatsAppConfig() {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONENUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.API_VERSION || process.env.WHATSAPP_API_VERSION || 'v18.0';
  return { token, phoneId, apiVersion };
}
(() => {
  const { token, phoneId } = resolveWhatsAppConfig();
  const required = [
    ['WHATSAPP_TOKEN', 'WHATSAPP_ACCESS_TOKEN'],
    ['WHATSAPP_PHONENUMBER_ID', 'WHATSAPP_PHONE_NUMBER_ID']
  ];
  const missing = [];
  if (!token) missing.push('WHATSAPP_TOKEN|WHATSAPP_ACCESS_TOKEN');
  if (!phoneId) missing.push('WHATSAPP_PHONENUMBER_ID|WHATSAPP_PHONE_NUMBER_ID');
  if (missing.length) {
    console.warn(`⚠️  WARNING: Missing default WhatsApp config: ${missing.join(', ')}`);
    console.warn(`ℹ️  Server will rely on Client Database Configuration for WhatsApp credentials.`);
    // throw new Error(`Missing WhatsApp config: ${missing.join(', ')}`);
  }
})();

const path = require('path');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the 'public' directory
app.use('/public', express.static(path.join(__dirname, 'public')));

// Debug Middleware: Log all incoming requests
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.originalUrl}`);
  next();
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/analytics', analyticsRoutes);
const businessRoutes = require('./routes/business');

// Dynamic Client Router (Replaces hardcoded client routes)
// Handles /api/client/:clientId/webhook
app.use('/api/client/:clientId', dynamicClientRouter);

app.use('/api/business', businessRoutes);

// app.use('/api/client/0001', turfClientRoutes);
// app.use('/api/client/0002', vedClientRoutes);
app.use('/r', trackingRoutes);

// Homepage endpoint
app.get('/homepage', (req, res) => {
  res.status(200).json({
    message: 'Hello World',
    status: 'success'
  });
});


// Keep-alive endpoint
app.post('/keepalive-ping', (req, res) => {
  console.log(`🔁 Keepalive ping received at ${new Date().toISOString()}`);
  res.status(200).json({ message: 'Server is awake!' });
});

app.get('/keepalive-ping', (req, res) => {
  res.status(200).json({ message: 'Server is awake via GET!' });
});

// --- TEMPORARY ROUTE TO UPGRADE CHOICE SALON TO V2 (Since Render Free Tier has no shell access) ---
app.get('/api/fix-v2', async (req, res) => {
  try {
    const Client = require('./models/Client');
    await Client.updateMany(
      { clientId: { $in: ['choice_salon', 'choice_salon_holi'] } },
      { $set: { subscriptionPlan: 'v2' } }
    );
    res.json({ success: true, message: 'Upgraded choice_salon and choice_salon_holi to v2 successfully!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- TEMPORARY ROUTE TO SEND HOLI PROMO ---
app.get('/api/send-holi', async (req, res) => {
  // Start the background process immediately so the 100s Render timeout doesn't kill the request
  res.status(200).json({ message: 'Holi Promo dispatch started in the background. Check server logs for progress.' });

  try {
    const Client = require('./models/Client');
    const axios = require('axios');
    const client = await Client.findOne({ businessType: 'choice_salon' });
    if (!client) {
      console.log('[HOLI DISPATCH ERROR] Client not found');
      return;
    }

    const token = client.whatsappToken;
    const phoneNumberId = client.phoneNumberId;

    // The user's provided list of raw numbers
    const rawNumbers = [
      '+91 6352 491 488', '+91 87583 70609', '+91 98251 96413', '+91 99040 96683',
      '+91 88662 05204', '+91 96013 04846', '+91 99785 45458', '+91 6354 776 189',
      '+91 99980 41144', '+91 6352 491 488', '+91 98252 83143', '+91 99135 45458',
      '+91 70419 63524', '+91 99096 18458', '+91 98244 74547', '+91 94846 07042',
      '+91 98790 95371', '+91 6355 411 809', '+91 6353 306 984', '+91 9313 045 439'
    ];

    // Clean numbers and remove duplicates
    const testNumbers = [...new Set(rawNumbers.map(n => n.replace(/\D/g, '')))];

    console.log(`[HOLI DISPATCH] Starting to send to ${testNumbers.length} unique numbers...`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const BirthdayUser = require('./models/BirthdayUser');
    const Appointment = require('./models/Appointment');

    for (let i = 0; i < testNumbers.length; i++) {
      const number = testNumbers[i];

      // --- OPT-OUT CHECK ---
      // Check if user replied STOP (isOpted: false in BirthdayUser)
      const isBirthdayOptedOut = await BirthdayUser.findOne({ number: number, isOpted: false });
      if (isBirthdayOptedOut) {
        console.log(`[HOLI DISPATCH] (${i + 1}/${testNumbers.length}) 🚫 Skipped (Opted Out): ${number}`);
        continue;
      }

      // Check if user opted out from marketing messages via Appointment logic
      const isApptOptedOut = await Appointment.findOne({ phone: number, 'consent.marketingMessages': false });
      if (isApptOptedOut) {
        console.log(`[HOLI DISPATCH] (${i + 1}/${testNumbers.length}) 🚫 Skipped (Marketing Opt-Out): ${number}`);
        continue;
      }
      // ---------------------

      const templateData = (langCode) => ({
        messaging_product: 'whatsapp',
        to: number,
        type: 'template',
        template: {
          name: 'holi_offer_1',
          language: { code: langCode },
          components: [
            {
              type: 'header',
              parameters: [
                {
                  type: 'image',
                  image: {
                    link: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/public/images/1.png`
                  }
                }
              ]
            }
          ]
        }
      });

      try {
        const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
        const r = await axios.post(url, templateData('en'), {
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
        });
        console.log(`[HOLI DISPATCH] (${i + 1}/${testNumbers.length}) ✅ Success: ${number}`);
      } catch (e) {
        if (e.response?.data?.error?.message?.includes('language')) {
          try {
            const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
            const r2 = await axios.post(url, templateData('en_US'), {
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
            });
            console.log(`[HOLI DISPATCH] (${i + 1}/${testNumbers.length}) ✅ Success (en_US): ${number}`);
          } catch (err2) {
            console.error(`[HOLI DISPATCH] (${i + 1}/${testNumbers.length}) ❌ Error (en_US retry): ${number} -`, err2.response?.data?.error || err2.message);
          }
        } else {
          console.error(`[HOLI DISPATCH] (${i + 1}/${testNumbers.length}) ❌ Error: ${number} -`, e.response?.data?.error || e.message);
        }
      }

      // If not the last number, wait 5 seconds to avoid spamming the API and getting banned
      if (i < testNumbers.length - 1) {
        await sleep(5000);
      }
    }
    console.log(`[HOLI DISPATCH] Finished sending templates!`);
  } catch (err) {
    console.error(`[HOLI DISPATCH] Fatal Error:`, err.message);
  }
});

// Self-ping to keep render free-tier awake. Runs every 10 minutes.
cron.schedule('*/10 * * * *', () => {
  const url = process.env.SERVER_URL || `https://chatbot-backend-lg5y.onrender.com`;
  console.log(`[Self-Ping] Pinging ${url}/keepalive-ping to prevent sleep...`);
  const https = require('https');
  https.get(`${url}/keepalive-ping`, (resp) => {
    let data = '';
    resp.on('data', (chunk) => data += chunk);
    resp.on('end', () => console.log('[Self-Ping] awake!', data));
  }).on('error', (err) => {
    console.error('[Self-Ping] Error:', err.message);
  });
});

// Initialize Abandoned Cart Cron Job
scheduleAbandonedCartCron();

// Cron job for birthday messages and appointment reminders
cron.schedule('0 6 * * *', async () => {
  const istNow = DateTime.utc().setZone('Asia/Kolkata');
  const currentDay = istNow.day;
  const currentMonth = istNow.month;

  console.log(`⏰ It's 6:00 AM IST — Running birthday check...`);

  try {
    const clients = await Client.find({});

    for (const client of clients) {
      const token = client.whatsappToken || process.env.WHATSAPP_TOKEN;
      const phoneid = client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
      const clientId = client.clientId;

      if (!token || !phoneid) {
        console.log(`⚠️ Skipping birthday check for client ${clientId} - missing WhatsApp credentials`);
        continue;
      }

      // Find birthday users for this client
      // Handle legacy data (no clientId) by assigning it to 'code_clinic_v1'
      let clientQuery = {
        day: currentDay,
        month: currentMonth,
        isOpted: true
      };

      if (clientId === 'code_clinic_v1') {
        clientQuery.$or = [{ clientId: clientId }, { clientId: { $exists: false } }];
      } else {
        clientQuery.clientId = clientId;
      }

      const todaysBirthdays = await BirthdayUser.find(clientQuery);

      if (todaysBirthdays.length === 0) continue;

      console.log(`🎉 Found ${todaysBirthdays.length} birthday(s) for client ${clientId}`);

      let successCount = 0;
      let failureCount = 0;

      async function incDaily(field) {
        const dateStr = istNow.toISODate();
        await DailyStat.updateOne(
          { clientId: clientId, date: dateStr },
          { $inc: { [field]: 1 }, $setOnInsert: { clientId: clientId, date: dateStr } },
          { upsert: true }
        );
      }

      for (const user of todaysBirthdays) {
        try {
          const result = await sendBirthdayWishWithImage(user.number, token, phoneid, clientId);
          if (result.success) {
            successCount++;
            await incDaily('birthdayRemindersSent');
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

      console.log(`🎂 Birthday messages for ${clientId} completed: ${successCount} sent, ${failureCount} failed`);
    }

  } catch (error) {
    console.error('❌ Error in birthday cron job:', error.message);
  }
});

// Cron job for appointment reminders (run daily at 7 AM)
cron.schedule('0 7 * * *', async () => {
  const istNow = DateTime.utc().setZone('Asia/Kolkata');
  const today = istNow.toFormat('EEEE, dd MMM');

  console.log(`⏰ Running appointment reminder check for today (${today})...`);

  try {
    const clients = await Client.find({});
    const { listEvents } = require('./utils/googleCalendar');
    const { sendAppointmentReminder } = require('./utils/sendAppointmentReminder');

    for (const client of clients) {
      const token = client.whatsappToken || process.env.WHATSAPP_TOKEN;
      const phoneid = client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
      const clientId = client.clientId;

      if (!token || !phoneid) continue;

      // Get events from both doctor calendars and main calendar
      const calendarIds = [];
      if (client.googleCalendarId) calendarIds.push(client.googleCalendarId);
      if (client.config && client.config.calendars) {
        calendarIds.push(...Object.values(client.config.calendars));
      }

      // Fallback for legacy Code Clinic if no specific calendars configured
      if (clientId === 'code_clinic_v1' && calendarIds.length === 0) {
        if (process.env.GCAL_CALENDAR_ID) calendarIds.push(process.env.GCAL_CALENDAR_ID);
        if (process.env.GCAL_CALENDAR_ID2) calendarIds.push(process.env.GCAL_CALENDAR_ID2);
      }

      if (calendarIds.length === 0) continue;

      const startOfDay = istNow.startOf('day').toISO();
      const endOfDay = istNow.endOf('day').toISO();

      let allTodayEvents = [];

      for (const calendarId of calendarIds) {
        try {
          const events = await listEvents(startOfDay, endOfDay, calendarId);
          allTodayEvents = allTodayEvents.concat(events);
        } catch (error) {
          console.error(`❌ Error fetching events from calendar ${calendarId} for client ${clientId}:`, error.message);
        }
      }

      if (allTodayEvents.length === 0) continue;

      console.log(`📅 Found ${allTodayEvents.length} events for client ${clientId}`);

      // Process each event and send reminders to users who have consented
      for (const event of allTodayEvents) {
        try {
          // Extract phone number from event description
          const phoneMatch = event.description?.match(/Phone:\s*([^\n]+)/);
          if (!phoneMatch) {
            // console.log(`⚠️ No phone number found in event: ${event.summary}`);
            continue;
          }

          const phoneNumber = phoneMatch[1].trim();

          // Check if user has consented to appointment reminders
          // Note: We search by phone. In future, we might want to verify they are associated with this client.
          const userAppointments = await Appointment.find({
            phone: phoneNumber,
            'consent.appointmentReminders': true
          });

          if (userAppointments.length === 0) {
            // console.log(`❌ Skipping reminder for ${phoneNumber} - user has not consented to reminders`);
            continue;
          }

          // Extract appointment details from event
          const nameMatch = event.description?.match(/Name:\s*([^\n]+)/);
          const serviceMatch = event.description?.match(/Service:\s*([^\n]+)/);
          const doctorMatch = event.description?.match(/Doctor:\s*([^\n]+)/);

          const patientName = nameMatch ? nameMatch[1].trim() : "Valued Customer";
          const service = serviceMatch ? serviceMatch[1].trim() : "Service";
          const doctor = doctorMatch ? doctorMatch[1].trim() : "Our Professional";

          // Format appointment time
          const eventTime = DateTime.fromISO(event.start.dateTime).setZone('Asia/Kolkata');
          const time = eventTime.toFormat('h:mm a');

          await sendAppointmentReminder(phoneid, token, phoneNumber, {
            summary: event.summary || `Appointment: ${patientName} - ${service} with ${doctor}`,
            start: event.start.dateTime,
            doctor: doctor,
            date: today,
            time: time
          }, clientId);

          console.log(`✅ Appointment reminder sent to ${phoneNumber} for ${time}`);
          try {
            const dateStr = istNow.toISODate();
            await DailyStat.updateOne(
              { clientId: clientId, date: dateStr },
              { $inc: { appointmentRemindersSent: 1 }, $setOnInsert: { clientId: clientId, date: dateStr } },
              { upsert: true }
            );
          } catch { }

          // Add delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
          console.error(`❌ Error processing appointment reminder for event ${event.id}:`, error.message);
        }
      }
      console.log(`🎯 Appointment reminders completed for client ${clientId}`);
    }
  } catch (err) {
    console.error('❌ Error in appointment reminder cron job:', err);
  }
});

// Admin 1-Hour Appointment Reminder (Choice Salon Specific)
// Runs every 10 minutes, looking for appointments exactly 1 hour (± 5 mins) from now.
cron.schedule('*/10 * * * *', async () => {
  console.log(`⏰ Running Admin 1-hour appointment reminder check...`);
  try {
    const clients = await Client.find({ clientId: { $in: ['choice_salon', 'choice_salon_holi'] } });
    const { listEvents } = require('./utils/googleCalendar');
    const { sendWhatsAppText } = require('./utils/whatsappHelpers'); // Or button helper if preferred

    // We want to find events starting between 55 minutes and 65 minutes from "now"
    const istNow = DateTime.utc().setZone('Asia/Kolkata');
    const windowStart = istNow.plus({ minutes: 55 }).toISO();
    const windowEnd = istNow.plus({ minutes: 65 }).toISO();

    for (const client of clients) {
      const token = client.whatsappToken || process.env.WHATSAPP_TOKEN;
      const phoneid = client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
      const clientId = client.clientId;
      const adminNumbers = ['919824474547']; // Hardcoded Choice Salon Admin

      if (!token || !phoneid) continue;

      // Get calendars
      const calendarIds = [];
      if (client.googleCalendarId) calendarIds.push(client.googleCalendarId);
      if (client.config && client.config.calendars) {
        calendarIds.push(...Object.values(client.config.calendars));
      }
      if (calendarIds.length === 0) continue;

      let upcomingEvents = [];
      for (const calendarId of calendarIds) {
        try {
          const events = await listEvents(windowStart, windowEnd, calendarId);
          upcomingEvents = upcomingEvents.concat(events);
        } catch (error) {
          console.error(`❌ Admin Reminder GCal Error (${calendarId}):`, error.message);
        }
      }

      for (const event of upcomingEvents) {
        try {
          // Prevent duplicate reminders by checking a custom Extended Property (if we could write it)
          // Since we can't easily write to GCal extended props without extra API calls, we rely on the narrow 10m window.
          // In a production scenario with potential overlapping cron runs, a DB log is safer.

          // Parse event info
          const nameMatch = event.description?.match(/Name:\s*([^\n]+)/);
          const serviceMatch = event.description?.match(/Service:\s*([^\n]+)/);
          const phoneMatch = event.description?.match(/Phone:\s*([^\n]+)/);

          const patientName = nameMatch ? nameMatch[1].trim() : "A client";
          const service = serviceMatch ? serviceMatch[1].trim() : event.summary.replace(patientName, '').replace('-', '').trim() || "Service";
          const phone = phoneMatch ? phoneMatch[1].trim() : "Unknown";

          const eventTime = DateTime.fromISO(event.start.dateTime).setZone('Asia/Kolkata').toFormat('h:mm a');

          const message = `🔔 *UPCOMING APPOINTMENT ALERT*\n\nYou have an appointment arriving in exactly *1 Hour*.\n\n👤 *Client:* ${patientName}\n📞 *Phone:* ${phone}\n💅 *Service:* ${service}\n⏰ *Time:* ${eventTime}\n\n_Please ensure the station is prepared!_ ✨`;

          for (const adminPhone of adminNumbers) {
            await sendWhatsAppText({
              phoneNumberId: phoneid,
              to: adminPhone,
              body: message,
              token: token
            });
          }
          console.log(`✅ Admin 1HR Reminder sent for ${patientName} at ${eventTime}`);
        } catch (err) {
          console.error(`❌ Error sending Admin Reminder:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('❌ Error in admin 1HR reminder cron:', err);
  }
});

const http = require('http');
const socketIo = require('socket.io');

console.log(`Starting server on port ${PORT}...`);

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

app.set('socketio', io);

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Join room based on clientId if provided in query
  const clientId = socket.handshake.query.clientId;
  if (clientId) {
    socket.join(`client_${clientId}`);
    console.log(`Socket ${socket.id} joined room client_${clientId}`);
  }

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`✅ Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed", err);
    process.exit(1);
  });

module.exports = app;
