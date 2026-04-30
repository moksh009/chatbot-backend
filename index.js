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
const compression = require('compression'); // Performance: GZIP compression — reduces payload sizes by 70-80%
const helmet = require('helmet'); // ✅ Phase R3: HTTP security headers — was installed, never applied
const mongoSanitize = require('express-mongo-sanitize'); // ✅ Phase R3: NoSQL injection protection — was installed, never applied
const rateLimit = require('express-rate-limit'); // ✅ Phase R3: Rate limiting — was installed, never applied
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
app.set('trust proxy', 1); // ✅ Phase R3: Trust first proxy (Render/Nginx) for accurate rate limiting
const PORT = process.env.PORT || 3000;

// WhatsApp Cloud API env validation (hard fail if missing)
function resolveWhatsAppConfig() {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONENUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.API_VERSION || process.env.WHATSAPP_API_VERSION || 'v21.0';
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
const { protect } = require('./middleware/auth');

// ✅ Phase R3: Security Middleware Stack — helmet + mongoSanitize applied globally
app.use(helmet({
  // Allow cross-origin for media assets (WhatsApp media proxy, etc.)
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // CSP disabled — managed at CDN/Nginx layer for this SPA
  contentSecurityPolicy: false
}));

// ✅ Phase R3: Rate Limiters — brute-force and API flood protection
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' }
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 80, // 80 AI calls/minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'AI rate limit exceeded. Please wait before sending another message.' }
});

const bulkLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 bulk ops/minute (campaigns, broadcasts)
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Bulk operation rate limit exceeded. Please wait before sending another campaign.' }
});

// --- PHASE 1: CORE MIDDLEWARE (CORS & Compression) ---
// CORS must be first to handle pre-flight OPTIONS requests from any origin
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://chatbot-backend-lg5y.onrender.com',
  'https://chatbot-dashboard-frontend-main.onrender.com',
  /\.onrender\.com$/  // Allow all onrender subdomains
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    // Always allow the origin to support widgets and pixels on client sites
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));

app.use(compression()); // Performance: GZIP all JSON responses (70-80% smaller payloads)

// ── CRITICAL: IG Webhook — must be mounted BEFORE global express.json() ──
// Meta's HMAC-SHA256 signature verification requires the unparsed raw body.
// Mounting this route before express.json() guarantees the body stream is untouched.
const webhookController = require('./controllers/igAutomation/webhookController');
app.use('/api/ig-automation/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  // Parse the raw buffer into req.body for downstream handlers, while preserving rawBody
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    try {
      req.body = JSON.parse(req.rawBody.toString('utf-8'));
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
  }
  next();
}, webhookController);

app.use(express.json({
  limit: '5mb', // ✅ Phase R3: Reduced from 10mb — prevents oversized payload DoS
  verify: (req, res, buf) => {
    req.rawBody = buf; // Still capture rawBody for any other routes that may need it
  }
}));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ✅ Phase R3: NoSQL injection sanitization — strips $ and . from request body/query
app.use(mongoSanitize({ replaceWith: '_' }));

// Phase 24: White-label domain detection (runs on every request, before routes)
const whitelabelMiddleware = require('./middleware/whitelabel');
app.use(whitelabelMiddleware);

const HealthController = require('./controllers/HealthController');
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Debug Middleware: Log all incoming requests
app.use((req, res, next) => {
  log.info(`${req.method} ${req.originalUrl}`);
  next();
});

// API Routes
app.use('/api/auth', authLimiter, authRoutes); // ✅ Phase R3: Brute-force protection on auth
app.use('/api/conversations', conversationRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/analytics', analyticsRoutes);

const knowledgeRoutes = require('./routes/knowledge');
app.use('/api/knowledge', knowledgeRoutes);

const scoringRoutes = require('./routes/scoring');
app.use('/api/scoring', scoringRoutes);

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
app.use('/api/flows', flowRoutes);

const publicWarrantyRoutes = require('./routes/publicWarranty');
app.use('/api/public/warranty', publicWarrantyRoutes);

const biRoutes = require('./routes/bi'); // Phase 28 Track 4
app.use('/api/bi', biRoutes);



const ordersRoutes = require('./routes/orders');
app.use('/api/orders', ordersRoutes);

const businessRoutes = require('./routes/business');
app.use('/api/business', businessRoutes);
const shopifyOAuthRoutes = require('./routes/shopifyOAuth'); // Shopify OAuth 2.0 flow (auth + callback)
const shopifyRoutes = require('./routes/shopify');
app.use('/api/shopify', shopifyOAuthRoutes); // OAuth routes first (static /auth, /callback paths)
app.use('/api/shopify', shopifyRoutes);       // Then param-based /:clientId/* routes

const shopifyHubRoutes = require('./routes/shopifyHub');
const wooHubRoutes = require('./routes/wooHub');
app.use('/api/shopify-hub', shopifyHubRoutes);
app.use('/api/woo-hub', wooHubRoutes);
const shopifyWebhookRoutes = require('./routes/shopifyWebhook');
app.use('/api/shopify/webhook', shopifyWebhookRoutes);
app.use('/api/woocommerce/webhook', wooWebhookRoutes);
const adminRoutes = require('./routes/admin'); // Added for DFY SaaS Super Admin
const mediaRoutes = require('./routes/media');

// Dynamic Client Router (Replaces hardcoded client routes)
// Handles /api/client/:clientId/webhook
app.use('/api/client/:clientId', dynamicClientRouter);

// Specific channel webhooks
// (Instagram now handled inside dynamicClientRouter)

app.use('/api/business', businessRoutes);
app.use('/api/admin', adminRoutes); // Super Admin Route Registration
app.use('/api/templates', templatesRoutes);
app.use('/api/auto-templates', require('./routes/autoTemplates'));
app.use('/api/whatsapp', whatsappRoutes);
const whatsappFlowsRoutes = require('./routes/whatsappFlows');
app.use('/api/whatsapp-flows', whatsappFlowsRoutes);
app.use('/api/campaigns', bulkLimiter, campaignsRoutes); // ✅ Phase R3: Bulk send protection
const emailWebhookRoutes = require('./routes/emailWebhook');
app.use('/api/email', emailWebhookRoutes);
app.use('/api/payment', require('./routes/payment'));
app.use('/api/billing', require('./routes/billing'));

// app.use('/api/client/0001', turfClientRoutes);
// app.use('/api/client/0002', vedClientRoutes);
app.use('/r', trackingRoutes);

const notificationsRoutes = require('./routes/notifications');
app.use('/api/notifications', notificationsRoutes);

const dashboardRoutes = require('./routes/dashboard');
app.use('/api/dashboard', dashboardRoutes);

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
const onboardingRoutes = require('./routes/onboarding');
app.use('/api/onboarding', onboardingRoutes);
const teamRoutes = require('./routes/team');
app.use('/api/team', teamRoutes);

// Phase 22: Rules Engine & Leads Engine & Routing Engine
const rulesRoutes = require('./routes/rules');
app.use('/api/rules', rulesRoutes);
const leadsRoutes = require('./routes/leads');
app.use('/api/leads', leadsRoutes);
const audienceRoutes = require('./routes/audience');
app.use('/api/audience', audienceRoutes);
const routingRoutes = require('./routes/routingRules');
app.use('/api/routing', routingRoutes);

// --- DETERMINISTIC INTENT ENGINE ROUTES ---
const intentRoutes = require('./routes/intents');
const intentWebhookRoutes = require('./routes/intentWebhooks');
app.use('/api/intents', intentRoutes);
app.use('/api/webhooks', intentWebhookRoutes); // Mounts /api/webhooks/meta

app.use('/api/razorpay', require('./routes/razorpayWebhook'));
const shopifyPixelRoutes = require('./routes/shopifyPixel');
app.use('/api/shopify-pixel', shopifyPixelRoutes);
const wooPixelRoutes = require('./routes/wooPixel');
app.use('/api/woocommerce-pixel', wooPixelRoutes);

// Phase 24: Growth & Health Check (Deep Monitoring)
app.get('/api/health', HealthController.checkHealth);

// Inbound Messaging Webhooks
app.use('/api/webhooks', require('./routes/intentWebhooks'));
app.use('/api/qrcodes', require('./routes/qrcodes'));
app.use('/api/catalog', require('./routes/catalog'));
// app.use('/api/payout', protect, require('./routes/payout')); // REMOVED: File doesn't exist
app.use('/api/training', require('./routes/training'));
// app.use('/api/ig-automation', protect, require('./routes/igAutomation')); // REMOVED: Redundant and points to missing igAutomation.js (use /api/instagram-automations instead)
app.use('/api/meta-ads', require('./routes/metaAds'));
app.use('/api/whitelabel', require('./routes/whitelabel'));
app.use('/api', require('./routes/dataDeletion')); // Meta compliance: data deletion callback + account deletion
app.use('/api/media', mediaRoutes);
app.use('/api/reseller', require('./routes/reseller'));

// Phase 27: Loyalty Hub & Enterprise Rewards
app.use('/api/loyalty', require('./routes/loyalty'));
app.use('/api/warranty', require('./routes/warranty'));
app.use('/api/template-gate', require('./routes/templateGate'));

// Bot Quality Analytics (replaces deleted /api/intelligence/footprint)
app.use('/api/bot-quality', require('./routes/botQuality'));

// Intelligence DNA route (Customer 360 — LiveChat deferred intelligence)
app.use('/api/intelligence', require('./routes/intelligenceDna'));

// ─── EXPRESS ALIASES: Frontend API compatibility ───
// The frontend calls these paths but backend mounts under different names.
app.use('/api/flow-builder', flowRoutes);           // Frontend: /api/flow-builder/flows → /api/flow/flows
app.use('/api/users', teamRoutes);                   // Frontend: /api/users/team → /api/team
app.use('/api/automation', sequencesRoutes);          // Frontend: /api/automation/sequences → /api/sequences

// Phase 30: Auto-Keywords
app.use('/api/keywords', require('./routes/keywords'));

// --- CRON JOBS (Phase 21 Resumption) ---
const scheduleFlowResumption = require('./cron/flowResumptionCron');
scheduleFlowResumption();

// Phase 27: Loyalty Hub & Enterprise Rewards
const scheduleLoyaltyUrgency = require('./cron/loyaltyCron');
scheduleLoyaltyUrgency();


const instagramAutomationRoutes = require('./routes/instagramAutomation');
app.use('/api/instagram-automations', instagramAutomationRoutes);

// IG Automation Module — Enterprise Comment-to-DM & Story-to-DM
const igAutomationRoutes = require('./routes/igAutomationRoutes');
app.use('/api/ig-automation', igAutomationRoutes);

// Unified Inbox — merge-sort WhatsApp + Instagram conversations
const inboxRoutes = require('./routes/inboxRoutes');
app.use('/api/inbox', inboxRoutes);


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

// Template approval status sync (pending -> syncedMetaTemplates)
const scheduleTemplateStatusSyncCron = require('./cron/templateStatusSyncCron');
scheduleTemplateStatusSyncCron();

// Initialize Amazon SP-API Sync (Phase 2)
const scheduleAmazonSync = require('./cron/amazonSync');
scheduleAmazonSync();

const scheduleStatCacheCron = require('./cron/statCacheCron');
scheduleStatCacheCron();

// Initialize Flow Resumption Cron Job (Phase 17) - ALREADY INITIALIZED ABOVE AT LINE 156

// Initialize Auto-Resume Bot Cron Job (Task 2.2)
const scheduleAutoResumeBotCron = require('./cron/autoResumeBotCron');
scheduleAutoResumeBotCron();

// Initialize Intelligence Crons (Phase 28 Track 2)


// Initialize Auto-Healing Reset (Phase 28 Track 8)
const { resetDailyErrorCounts } = require('./utils/autoHealer');
cron.schedule('0 0 * * *', resetDailyErrorCounts);


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
require('./cron/leadScoringCron');

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
          log.warn(`[Cron] GCal Fetch skipped for client ${clientId} (${calendarId}):`, { error: error.message });
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
          if (error.message.includes('invalid_grant')) {
             // Only log a concise warning, avoid spamming stack traces for expired tokens
             log.warn(`[Cron] GCal token expired for ${calendarId} (invalid_grant)`);
          } else {
             log.warn(`[Cron] Admin Reminder GCal Error (${calendarId}):`, { error: error.message });
          }
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

const { init: initSocket } = require('./utils/socket');
const io = initSocket(server);
app.set('socketio', io);

connectDB()
  .then(async () => {
    // Phase 9 & 5: Prime the NLP Engine and Start Task Workers
    const { bootIntentEngine } = require('./services/EngineInitializer');
    require('./services/NlpWorker'); // Starts the BullMQ NLP worker process
    require('./services/TaskWorker'); // Starts the Generic Enterprise Task Worker process (Phase 5)
    require('./workers/igAutomationWorker'); // IG Automation: Comment-to-DM & Story-to-DM workers
    require('./workers/autoTemplateWorker'); // Auto Template Generation & Staged Meta Submission

    // IG Automation: Validate environment variables (non-fatal warnings)
    validateIGEnvironment();

    bootIntentEngine().catch(err => {
      log.error("[NLP_BOOT] Engine priming failed:", err.message);
    });

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
    error: err.message || "Internal Server Error"
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

// IG Automation: Startup environment validation (non-fatal warnings)
function validateIGEnvironment() {
  const required = {
    FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET,
    META_APP_SECRET: process.env.META_APP_SECRET
  };

  const missing = Object.entries(required)
    .filter(([, val]) => !val)
    .map(([key]) => key);

  if (missing.length > 0) {
    log.warn(`[Startup] IG Automation: Missing environment variables: ${missing.join(', ')}. IG features may not work correctly.`);
  } else {
    log.info('[Startup] IG Automation environment variables validated successfully.');
  }

  if (!process.env.IG_WEBHOOK_VERIFY_TOKEN) {
    log.warn('[Startup] IG_WEBHOOK_VERIFY_TOKEN not set. Webhook verification handshake will fail.');
  }
}

