const express = require('express');
const dotenv = require('dotenv');
const log = require('./utils/logger')('Server');
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
  log.error("Dotenv Error:", dotenvResult.error);
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
    log.warn(`Missing default WhatsApp config: ${missing.join(', ')}`);
    log.info(`Server will rely on Client Database Configuration for WhatsApp credentials.`);
    // throw new Error(`Missing WhatsApp config: ${missing.join(', ')}`);
  }
})();

const path = require('path');

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    // Allow all origins, mirroring the incoming origin
    callback(null, true);
  }, 
  credentials: true
}));
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Phase 24: White-label domain detection (runs on every request, before routes)
const whitelabelMiddleware = require('./middleware/whitelabel');
app.use(whitelabelMiddleware);

// Serve static files from the 'public' directory
app.use('/public', express.static(path.join(__dirname, 'public')));

// Debug Middleware: Log all incoming requests
app.use((req, res, next) => {
  log.info(`${req.method} ${req.originalUrl}`);
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
const ecommerceRoutes = require('./routes/ecommerce');
app.use('/api/ecommerce', ecommerceRoutes);
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
const wooHubRoutes = require('./routes/wooHub');
app.use('/api/shopify-hub', shopifyHubRoutes);
app.use('/api/woo-hub', wooHubRoutes);
const shopifyWebhookRoutes = require('./routes/shopifyWebhook');
app.use('/api/shopify/webhook', shopifyWebhookRoutes);
app.use('/api/woocommerce/webhook', wooWebhookRoutes);
const adminRoutes = require('./routes/admin'); // Added for DFY SaaS Super Admin

// Dynamic Client Router (Replaces hardcoded client routes)
// Handles /api/client/:clientId/webhook
app.use('/api/client/:clientId', dynamicClientRouter);

// Specific channel webhooks
// (Instagram now handled inside dynamicClientRouter)

app.use('/api/business', businessRoutes);
app.use('/api/admin', adminRoutes); // Super Admin Route Registration
app.use('/api/templates', templatesRoutes); 
app.use('/api/whatsapp', whatsappRoutes);
const whatsappFlowsRoutes = require('./routes/whatsappFlows');
app.use('/api/whatsapp-flows', whatsappFlowsRoutes);
app.use('/api/campaigns', campaignsRoutes);
const emailWebhookRoutes = require('./routes/emailWebhook');
app.use('/api/email', emailWebhookRoutes);
app.use('/api/payment', require('./routes/payment')); 
app.use('/api/billing', require('./routes/billing')); 

// app.use('/api/client/0001', turfClientRoutes);
// app.use('/api/client/0002', vedClientRoutes);
app.use('/r', trackingRoutes);

const notificationsRoutes = require('./routes/notifications');
app.use('/api/notifications', notificationsRoutes);

const supportRoutes = require('./routes/support');
app.use('/api/support', supportRoutes);
app.use('/api/support-chat', supportRoutes); // Public alias for website chat widget


// Phase 19: Pre-flight Validation Routes
const validationRoutes = require('./routes/validation');
app.use('/api/validate', validationRoutes);

// Phase 20: Instagram OAuth + AI Wizard Routes
const oauthRoutes = require('./routes/oauth');
app.use('/api/oauth', oauthRoutes);
const wizardRoutes = require('./routes/wizard');
app.use('/api/wizard', wizardRoutes);
const teamRoutes = require('./routes/team');
app.use('/api/team', teamRoutes);

// Phase 22: Rules Engine & Leads Engine & Routing Engine
const rulesRoutes = require('./routes/rules');
app.use('/api/rules', rulesRoutes);
const leadsRoutes = require('./routes/leads');
app.use('/api/leads', leadsRoutes);
const routingRoutes = require('./routes/routingRules');
app.use('/api/routing', routingRoutes);

// Phase 23: Billing Engine & Webhooks
app.use('/api/billing', require('./routes/billing'));
app.use('/api/razorpay', require('./routes/razorpayWebhook'));
const shopifyPixelRoutes = require('./routes/shopifyPixel');
app.use('/api/shopify-pixel', shopifyPixelRoutes);
const wooPixelRoutes = require('./routes/wooPixel');
app.use('/api/woocommerce-pixel', wooPixelRoutes);
const segmentRoutes = require('./routes/segments');
app.use('/api/segments', segmentRoutes);

// Phase 24: Growth & Integration Layer
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/qrcodes', require('./routes/qrcodes'));
app.use('/api/catalog', require('./routes/catalog'));
app.use('/api/meta-ads', require('./routes/metaAds'));
app.use('/api/whitelabel', require('./routes/whitelabel'));
app.use('/api/reseller', require('./routes/reseller'));

// --- CRON JOBS (Phase 21 Resumption) ---
const scheduleFlowResumption = require('./cron/flowResumptionCron');
scheduleFlowResumption();


const instagramAutomationRoutes = require('./routes/instagramAutomation');
app.use('/api/instagram-automations', instagramAutomationRoutes);


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
  log.info(`Keepalive ping received`);
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
  log.info(`[Self-Ping] Pinging ${url}/keepalive-ping to prevent sleep...`);
  const https = require('https');
  https.get(`${url}/keepalive-ping`, (resp) => {
    let data = '';
    resp.on('data', (chunk) => data += chunk);
    resp.on('end', () => log.info('[Self-Ping] awake!', { data }));
  }).on('error', (err) => {
    log.error('[Self-Ping] Error:', { message: err.message });
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

// Initialize Flow Resumption Cron Job (Phase 17) - ALREADY INITIALIZED ABOVE AT LINE 156


// Phase 20: Instagram Token Refresh Cron (daily at 8AM IST)
const { refreshExpiringInstagramTokens } = require('./routes/oauth');
cron.schedule('0 8 * * *', async () => {
  log.info('[Cron] Running Instagram token refresh check...');
  try { await refreshExpiringInstagramTokens(); }
  catch (err) { log.error('[Cron] Instagram token refresh error:', { error: err.message }); }
}, { timezone: 'Asia/Kolkata' });

// Phase 24: Meta Ads Daily Sync (6AM IST — before business hours)
const { syncMetaAds } = require('./utils/metaAdsAPI');
cron.schedule('0 6 * * *', async () => {
  log.info('[Cron] Running Meta Ads sync for all connected clients...');
  try {
    const connectedClients = await Client.find({ metaAdsConnected: true, isActive: true }).lean();
    for (const c of connectedClients) {
      syncMetaAds(c.clientId).catch(err => log.error(`[MetaAds] Cron sync error for ${c.clientId}:`, { error: err.message }));
    }
  } catch (err) { log.error('[Cron] MetaAds sync error:', { error: err.message }); }
}, { timezone: 'Asia/Kolkata' });

// Phase 11 Cron Jobs
require('./cron/followUpSequenceCron')();
require('./cron/campaignSchedulerCron')();
require('./cron/abTestCron')();
require('./cron/abTestWinner');
require('./cron/insightsCron')();
require('./cron/csatCron')();

// Cron job for appointment reminders (run daily at 7 AM)
cron.schedule('0 7 * * *', async () => {
  const istNow = DateTime.utc().setZone('Asia/Kolkata');
  const today = istNow.toFormat('EEEE, dd MMM');

  log.info(`[Cron] Running appointment reminder check for today (${today})...`);

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
        log.info(`[Cron] Skipping 7 AM user reminders for ${clientId} as requested by admin.`);
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
          log.error(`[Cron] Error fetching events from calendar ${calendarId} for client ${clientId}:`, { error: error.message });
        }
      }

      if (allTodayEvents.length === 0) continue;

      log.info(`[Cron] Found ${allTodayEvents.length} events for client ${clientId}`);

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

          log.info(`[Cron] Appointment reminder sent to ${phoneNumber} for ${time}`);
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
          log.error(`[Cron] Error processing appointment reminder for event ${event.id}:`, { error: error.message });
        }
      }
      log.info(`[Cron] Appointment reminders completed for client ${clientId}`);
    }
  } catch (err) {
    log.error('[Cron] Error in appointment reminder cron job:', { error: err.message });
  }
});

// Admin 1-Hour Appointment Reminder (Choice Salon Specific)
// Runs every 10 minutes, looking for appointments exactly 1 hour (± 5 mins) from now.
cron.schedule('*/10 * * * *', async () => {
  log.info(`[Cron] Running Admin 1-hour appointment reminder check...`);
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
          log.error(`[Cron] Admin Reminder GCal Error (${calendarId}):`, { error: error.message });
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
          log.info(`[Cron] Admin 1HR Reminder sent for ${patientName} at ${eventTime}`);
        } catch (err) {
          log.error(`[Cron] Error sending Admin Reminder:`, { error: err.message });
        }
      }
    }
  } catch (err) {
    log.error('[Cron] Error in admin 1HR reminder cron:', { error: err.message });
  }
});

const http = require('http');
const socketIo = require('socket.io');

log.info(`Starting server on port ${PORT}...`);

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.set('socketio', io);
global.io = io;

io.on('connection', (socket) => {
  log.info('New client connected', { socketId: socket.id });

  // Join room based on clientId if provided in query
  const clientId = socket.handshake.query.clientId;
  if (clientId) {
    socket.join(`client_${clientId}`);
    log.info(`Socket joined client room`, { socketId: socket.id, clientId });
  }

  // Join Super Admin room if role is provided
  const userRole = socket.handshake.query.role;
  if (userRole === 'SUPER_ADMIN') {
    socket.join('super_admin_room');
    log.info(`Socket joined super_admin_room`, { socketId: socket.id });
  }

  socket.on('disconnect', () => {
    log.info('Client disconnected', { socketId: socket.id });
  });
});

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      log.success(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    log.error("MongoDB connection failed", { error: err.message });
    process.exit(1);
  });

// Global Error Handler
app.use((err, req, res, next) => {
  log.error(`Global Error: ${req.method} ${req.url}`, { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Graceful Shutdown
process.on("SIGTERM", async () => {
  log.warn("SIGTERM received. Closing server gracefully.");
  server.close(async () => {
    const mongoose = require('mongoose');
    await mongoose.disconnect();
    log.info("MongoDB disconnected. Process exiting.");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  log.warn("SIGINT received. Closing server gracefully.");
  server.close(async () => {
    const mongoose = require('mongoose');
    await mongoose.disconnect();
    log.info("MongoDB disconnected. Process exiting.");
    process.exit(0);
  });
});

module.exports = app;
