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
const scheduleBirthdayCron = require('./cron/birthdayCron');
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
const trackingRoutes = require('./routes/tracking');
// const turfClientRoutes = require('./routes/clientcodes/turf'); // Deprecated in favor of dynamic router
// const vedClientRoutes = require('./routes/clientcodes/ved');   // Deprecated in favor of dynamic router
const dynamicClientRouter = require('./routes/dynamicClientRouter');
const templatesRoutes = require('./routes/templates');
const whatsappRoutes = require('./routes/whatsapp');
const instagramWebhookRoutes = require('./routes/instagramWebhook');
const wooWebhookRoutes = require('./routes/wooWebhook');

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
app.use(cors({
  origin: process.env.FRONTEND_URL || '*', 
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

// Phase 11 Routes
const insightsRoutes = require('./routes/insights');
app.use('/api/insights', insightsRoutes);
const segmentsRoutes = require('./routes/segments');
app.use('/api/segments', segmentsRoutes);
const sequencesRoutes = require('./routes/sequences');
app.use('/api/sequences', sequencesRoutes);
const settingsRoutes = require('./routes/settings');
app.use('/api/settings', settingsRoutes);
const flowRoutes = require('./routes/flow');
app.use('/api/flow', flowRoutes);
const ordersRoutes = require('./routes/orders');
app.use('/api/orders', ordersRoutes);

const businessRoutes = require('./routes/business');
app.use('/api/business', businessRoutes);
const shopifyRoutes = require('./routes/shopify');
app.use('/api/shopify', shopifyRoutes);

const shopifyHubRoutes = require('./routes/shopifyHub');
app.use('/api/shopify-hub', shopifyHubRoutes);
const shopifyWebhookRoutes = require('./routes/shopifyWebhook');
app.use('/api/shopify/webhook', shopifyWebhookRoutes);
app.use('/api/woocommerce/webhook', wooWebhookRoutes);
const adminRoutes = require('./routes/admin'); // Added for DFY SaaS Super Admin

// Dynamic Client Router (Replaces hardcoded client routes)
// Handles /api/client/:clientId/webhook
app.use('/api/client/:clientId', dynamicClientRouter);

// Specific channel webhooks
app.use('/api/client', instagramWebhookRoutes);

app.use('/api/business', businessRoutes);
app.use('/api/admin', adminRoutes); // Super Admin Route Registration
app.use('/api/templates', templatesRoutes); 
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/payment', require('./routes/payment')); 

// app.use('/api/client/0001', turfClientRoutes);
// app.use('/api/client/0002', vedClientRoutes);
app.use('/r', trackingRoutes);

// Master Webhook (Root Route for WhatsApp Meta Cloud API)
const masterWebhook = require('./routes/masterWebhook');
app.use('/', masterWebhook);

// Homepage endpoint (already handled above if root, but keeping as specific /homepage)
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

// --- REMOVED: Temporary one-time migration routes (/api/fix-v2, /api/send-holi, /api/send-choice-salon) ---
// These were used for one-off operations and have been removed for production security.

// --- REMOVED: /api/send-holi and /api/send-choice-salon (unauthenticated temp marketing routes, removed for production security) ---

// Self-ping placeholder — real self-ping cron is below
app.get('/api/REMOVED_TEMP_ROUTES', (req, res) => res.status(410).json({ message: 'Route removed' }));


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

// Initialize Review Collection Cron Job
const scheduleReviewCron = require('./cron/reviewCollection');
scheduleReviewCron();

// Initialize Birthday Messages Cron Job
scheduleBirthdayCron();

// Initialize Product Sync Cron Job
const scheduleProductSyncCron = require('./cron/productSyncCron');
scheduleProductSyncCron();

// Phase 11 Cron Jobs
require('./cron/followUpSequenceCron')();
require('./cron/campaignSchedulerCron')();
require('./cron/abTestCron')();
require('./cron/insightsCron')();
require('./cron/csatCron')();

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

      // USER REQUEST: Stop sending 7 AM reminders to Choice Salon & Choice Holi users
      if (clientId === 'choice_salon' || clientId === 'choice_salon_holi') {
        console.log(`ℹ️ Skipping 7 AM user reminders for ${clientId} as requested by admin.`);
        continue;
      }

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
      const adminNumbers = [...(client.config?.adminPhones || []), client.config?.adminPhone, '919824474547', process.env.ADMIN_PHONE_NUMBER].filter(Boolean);
      const uniqueAdmins = [...new Set(adminNumbers)];

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
          const nameMatch = event.description?.match(/Name:\s*([^\n]+)/i);
          const serviceMatch = event.description?.match(/Service:\s*([^\n]+)/i);
          const phoneMatch = event.description?.match(/Phone:\s*([^\n]+)/i);
          const stylistMatch = event.description?.match(/Stylist:\s*([^\n]+)/i);

          const patientName = nameMatch ? nameMatch[1].trim() : "A client";
          const service = serviceMatch ? serviceMatch[1].trim() : event.summary.replace(patientName, '').replace('-', '').replace('Appointment:', '').trim() || "Service";
          const phone = phoneMatch ? phoneMatch[1].trim() : "Unknown";
          const stylist = stylistMatch ? stylistMatch[1].trim() : "Not specified";

          const eventTime = DateTime.fromISO(event.start.dateTime).setZone('Asia/Kolkata').toFormat('h:mm a');

          const message = `🔔 *UPCOMING APPOINTMENT ALERT*\n\nYou have an appointment arriving in exactly *1 Hour*.\n\n👤 *Client:* ${patientName}\n📞 *Phone:* ${phone}\n💅 *Service:* ${service}\n💇‍♀️ *Stylist:* ${stylist}\n⏰ *Time:* ${eventTime}\n\n_Please ensure the station is prepared!_ ✨`;

          for (const adminPhone of uniqueAdmins) {
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
global.io = io;

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

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(`[Global Error] ${req.method} ${req.url}:`, err.message, err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Graceful Shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received. Closing server gracefully.");
  server.close(async () => {
    const mongoose = require('mongoose');
    await mongoose.disconnect();
    console.log("MongoDB disconnected. Process exiting.");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  console.log("SIGINT received. Closing server gracefully.");
  server.close(async () => {
    const mongoose = require('mongoose');
    await mongoose.disconnect();
    process.exit(0);
  });
});

module.exports = app;
