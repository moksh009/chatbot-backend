const express = require('express');
const dotenv = require('dotenv');
const log = require('./utils/logger')('Server');
const connectDB = require('./db');
const Client = require('./models/Client');
const { apiGeneralLimiter } = require('./middleware/enterpriseLimits');
// Load environment variables
// dotenv.config();
// Silence .env missing warning
const dotenvResult = dotenv.config();
if (dotenvResult.error && dotenvResult.error.code !== 'ENOENT') {
  log.error("Dotenv Error:", dotenvResult.error);
}
// If ENOENT, it just means no file, which is fine if envs are injected otherwise.

if (process.env.NODE_ENV === 'production' && !String(process.env.PUBLIC_BASE_URL || '').trim()) {
  log.warn(
    '[Config] PUBLIC_BASE_URL is not set — wizard logos, /uploads media, and WhatsApp header images may not resolve. See .env.example.'
  );
}


const cors = require('cors');
const compression = require('compression'); // Performance: GZIP compression — reduces payload sizes by 70-80%
const helmet = require('helmet'); // ✅ Phase R3: HTTP security headers — was installed, never applied
const mongoSanitize = require('express-mongo-sanitize'); // ✅ Phase R3: NoSQL injection protection — was installed, never applied
const rateLimit = require('express-rate-limit'); // ✅ Phase R3: Rate limiting — was installed, never applied
const authRoutes = require('./routes/auth');
const conversationRoutes = require('./routes/conversations');
const analyticsRoutes = require('./routes/analytics');
const campaignsRoutes = require('./routes/campaigns');
const trackingRoutes = require('./routes/tracking');
// const turfClientRoutes = require('./routes/clientcodes/turf'); // Deprecated in favor of dynamic router
// const vedClientRoutes = require('./routes/clientcodes/ved');   // Deprecated in favor of dynamic router
const dynamicClientRouter = require('./routes/dynamicClientRouter');
const templatesRoutes = require('./routes/templates');
const whatsappRoutes = require('./routes/whatsapp');
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
const { requireJwtSecret } = require('./middleware/productionSecurity');

try {
  requireJwtSecret();
} catch (e) {
  log.error(e.message);
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

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
  max: 20, // login/register brute-force only
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
  // Bootstrap is JWT-protected session refresh — not a brute-force surface
  skip: (req) => req.method === 'GET' && (req.path === '/bootstrap' || req.path === '/me'),
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
  /\.onrender\.com$/,
];

const envAllowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsStrict =
  process.env.CORS_STRICT === 'true' ||
  (process.env.NODE_ENV === 'production' &&
    envAllowedOrigins.length > 0 &&
    process.env.CORS_ALLOW_ALL !== 'true');

function isOriginAllowed(origin) {
  if (!origin) return true;
  const all = [...allowedOrigins, ...envAllowedOrigins];
  return all.some((entry) => {
    if (entry instanceof RegExp) return entry.test(origin);
    return entry === origin;
  });
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (!corsStrict) return callback(null, true);
    if (isOriginAllowed(origin)) return callback(null, true);
    log.warn(`[CORS] Blocked origin: ${origin}`);
    return callback(new Error('CORS policy: origin not allowed'));
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
const requestMetrics = require('./middleware/requestMetrics');

app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 86400000 }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '1h' }));

app.use(requestMetrics.middleware());

// Multi-tenant API flood guard (webhooks excluded — see enterpriseLimits.js)
app.use('/api', apiGeneralLimiter);

// Debug: set REQUEST_LOG=true to trace every request (avoid default prod noise + CPU)
app.use((req, res, next) => {
  if (process.env.REQUEST_LOG === 'true') {
    log.info(`${req.method} ${req.originalUrl}`);
  }
  next();
});

// API Routes
app.use('/api/auth', authLimiter, authRoutes); // ✅ Phase R3: Brute-force protection on auth
app.use('/api/conversations', conversationRoutes);
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

const aiRoutes = require('./routes/ai');
app.use('/api/ai', aiRoutes);

const publicWarrantyRoutes = require('./routes/publicWarranty');
app.use('/api/public/warranty', publicWarrantyRoutes);
app.use('/api/public/growth', require('./routes/publicGrowth'));
app.use('/api/growth', require('./routes/growth'));

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
app.use('/api/shopify-hub', shopifyHubRoutes);
const workspaceRoutes = require('./routes/workspace');
app.use('/api/workspace', workspaceRoutes);
const shopifyWebhookRoutes = require('./routes/shopifyWebhook');
app.use('/api/shopify/webhook', shopifyWebhookRoutes);
const shopifyCatalogRoutes = require('./routes/shopifyCatalog');
const checkoutShortLinkRoutes = require('./routes/checkoutShortLink');
app.use('/api/shopify-catalog', shopifyCatalogRoutes);
app.use('/api/r', checkoutShortLinkRoutes);
const shopifyComplianceRoutes = require('./routes/shopifyComplianceWebhooks');
app.use('/api/shopify/compliance', shopifyComplianceRoutes);
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
app.use('/api/meta-templates', require('./routes/metaTemplates'));
app.use('/api/custom-tags', require('./routes/customTags'));
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

const storeEconomicsRoutes = require('./routes/storeEconomics');
app.use('/api/store-economics', storeEconomicsRoutes);

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
const variablesRoutes = require('./routes/variables');
app.use('/api/variables', variablesRoutes);
// ─── Onboarding V2 (full-screen new-user flow) — mounted FIRST so its
// distinct paths (/analyze, /progress, /flow/generate, /complete, /track)
// take priority. Legacy /api/onboarding/:clientId handlers stay intact.
const onboardingV2Routes = require('./routes/onboardingV2');
app.use('/api/onboarding', onboardingV2Routes);

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
app.use('/api/webhooks', intentWebhookRoutes); // POST /api/webhooks/meta
app.use('/api/webhooks', require('./routes/webhooks')); // Outbound webhook CRUD for dashboard

app.use('/api/razorpay', require('./routes/razorpayWebhook'));
const shopifyPixelRoutes = require('./routes/shopifyPixel');
app.use('/api/shopify-pixel', shopifyPixelRoutes);

// Phase 24: Growth & Health Check (Deep Monitoring)
app.get('/api/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  await HealthController.checkHealth(req, res);
});
app.get('/api/metrics/summary', HealthController.metricsSummary);

app.use('/api/qrcodes', require('./routes/qrcodes'));
app.use('/api/catalog', require('./routes/catalog'));
app.use('/api/meta/workspace', require('./routes/metaWorkspace'));
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

// Phase 30: Auto-Keywords
app.use('/api/keywords', require('./routes/keywords'));

const instagramAutomationRoutes = require('./routes/instagramAutomation');
app.use('/api/instagram-automations', instagramAutomationRoutes);

// IG Automation Module — Enterprise Comment-to-DM & Story-to-DM
const igAutomationRoutes = require('./routes/igAutomationRoutes');
app.use('/api/ig-automation', igAutomationRoutes);

// Unified Inbox — merge-sort WhatsApp + Instagram conversations
const inboxRoutes = require('./routes/inboxRoutes');
app.use('/api/inbox', inboxRoutes);


// Master Webhook (WhatsApp Cloud API — shared callback for all tenants; routes by phone_number_id)
const masterWebhook = require('./routes/masterWebhook');
app.use('/', masterWebhook);
app.use('/whatsapp-webhook', masterWebhook);

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


const RUN_API = process.env.RUN_API !== 'false';
const RUN_WORKERS = process.env.RUN_WORKERS !== 'false';
const RUN_CRONS = process.env.RUN_CRONS !== 'false';

if (!RUN_CRONS) {
  log.info('[Boot] RUN_CRONS=false — cron jobs not started');
} else {
  const { registerAllCrons } = require('./cron/cronBootstrap');
  registerAllCrons();
}

if (RUN_API && RUN_CRONS && process.env.SUPPRESS_SPLIT_DEPLOY_WARN !== 'true') {
  const isProd = process.env.NODE_ENV === 'production';
  const msg =
    '[Boot] RUN_API=true and RUN_CRONS=true on the same process — Mongo pool contention likely. ' +
    'For local dev use ./scripts/start-api-dev.sh (API only) and ./scripts/start-crons-only.sh (crons) in a second terminal.';
  if (isProd) {
    log.warn(msg + ' Prefer separate Render services (API vs crons — see scripts/start-api-dev.sh).');
  } else {
    log.warn(msg);
  }
}

const http = require('http');
const server = RUN_API ? http.createServer(app) : null;

if (RUN_API) {
  log.info(`Starting HTTP server on port ${PORT}...`);
} else {
  log.info('[Boot] RUN_API=false — HTTP server will not bind');
}

connectDB()
  .then(async () => {
    const { logRedisHealth } = require('./utils/redisFactory');
    await logRedisHealth().catch(() => {});

    if (RUN_WORKERS) {
      require('./services/NlpWorker');
      require('./services/TaskWorker');
      require('./workers/igAutomationWorker');
      require('./workers/autoTemplateWorker');
    } else {
      log.info('[Boot] RUN_WORKERS=false — BullMQ workers not started');
    }

    // IG Automation: Validate environment variables (non-fatal warnings)
    validateIGEnvironment();

    if (RUN_CRONS) {
      // IG webhook heal — only when crons enabled (Graph API + Mongo burst off API-only dev)
      require('./services/igWebhookHealer').scheduleStartup();
    } else {
      log.info('[Boot] RUN_CRONS=false — IG webhook healer skipped');
    }

    if (!RUN_API || !server) {
      log.info('[Boot] RUN_API=false — workers/crons only mode (no HTTP listener)');
      return;
    }

    const { init: initSocket } = require('./utils/socket');
    const io = initSocket(server);
    app.set('socketio', io);

    server.listen(PORT, () => {
      log.success(`Server is running on port ${PORT}`);

      const deferMs = parseInt(process.env.DEFER_STARTUP_HEAVY_MS || '45000', 10) || 45000;
      setTimeout(() => {
        const { prewarmFlowCacheForActiveClients } = require('./utils/flowPrewarm');
        prewarmFlowCacheForActiveClients().catch((err) => {
          log.warn('[FlowPrewarm] deferred skipped:', err.message);
        });
        if (process.env.NLP_BOOT_DEFER !== 'false') {
          const { bootIntentEngine } = require('./services/EngineInitializer');
          bootIntentEngine().catch((err) => {
            log.error('[NLP_BOOT] deferred priming failed:', err.message);
          });
        }
      }, deferMs);
      log.info(`[Boot] Flow prewarm + NLP deferred ${deferMs}ms (API pool priority)`);
      // #region agent log
      try {
        const { agentDebug } = require('./utils/agentDebugLog');
        agentDebug({
          hypothesisId: 'H2',
          runId: 'boot',
          location: 'index.js:server.listen',
          message: 'server_listening',
          data: {
            node: process.version,
            port: PORT,
            hasMongoUri: !!process.env.MONGODB_URI,
            hasSystemMailCreds: !!(process.env.SYSTEM_EMAIL_USER && process.env.SYSTEM_EMAIL_PASS),
            hasWaDefaultToken: !!(process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN),
            hasGeminiKey: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY)
          }
        });
      } catch (_) { /* non-fatal */ }
      // #endregion
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

