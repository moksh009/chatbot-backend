const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Client = require('../models/Client');
const OTP = require('../models/OTP'); // Added OTP Model
const { protect } = require('../middleware/auth');
const { sanitizeMiddleware } = require('../utils/core/sanitize');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); // ✅ Phase R4: for authenticated change-password
/** Node Crypto (HMAC state signing). Do not rely on global `crypto` — Node 19+ exposes Web Crypto globally without createHmac. */
const crypto = require('crypto');
const { sendSystemOTPEmail } = require('../utils/core/emailService');
const { ensureClientForUser } = require('../utils/core/ensureClientForUser');
const { LEGAL_DOCS_VERSION } = require('../config/legalDocs');
const { validateStrongPassword } = require('../utils/core/passwordPolicy');
const {
  getAccessForUserClient,
  provisionNewClientTrial,
  repairActiveTrialFlags,
} = require('../utils/core/accessFlags');
const { auditSecurity } = require('../middleware/securityAudit');
const { auditLog } = require('../services/audit/auditWriter');
const {
  isLocked,
  recordFailedAttempt,
  clearFailedAttempts,
} = require('../utils/auth/loginSecurity');
const {
  getGoogleAuthRedirectUri,
  getGoogleOAuthPublicConfig,
} = require('../utils/auth/googleOAuthConfig');

function applyBootstrapSuperAdmin(user) {
  const allow = process.env.ALLOW_BOOTSTRAP_SUPER_ADMIN === 'true';
  const emails = String(process.env.BOOTSTRAP_SUPER_ADMIN_EMAILS || 'admin@topedgeai.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!allow || !user?.email) return user;
  if (!emails.includes(String(user.email).toLowerCase())) return user;
  if (user.role !== 'SUPER_ADMIN') {
    user.role = 'SUPER_ADMIN';
    user.isLifetimeAdmin = true;
    auditLog({
      category: 'super_admin',
      action: 'bootstrap_super_admin',
      severity: 'high',
      clientId: user.clientId,
      actor: { type: 'user', userId: user._id, source: 'auth' },
      details: { email: user.email },
      blocking: true,
    });
  }
  return user;
}

/** Canonical dashboard gates — must match TrialGate / workspaceAccess on the SPA. */
async function workspaceAccessForResponse(reqUser, clientDocOrNull) {
  if (!clientDocOrNull) {
    return {
      manuallySuspended: false,
      trialWindowActive: false,
      hasPaidAccess: false,
      dashboardLocked: true
    };
  }
  const lean = typeof clientDocOrNull.toObject === 'function'
    ? clientDocOrNull.toObject()
    : clientDocOrNull;
  return getAccessForUserClient(reqUser, lean);
}

/** Full session payload for login / register / OAuth — keeps SPA gates in sync with backend. */
async function buildAuthSessionPayload(user, client) {
  const lean = client
    ? typeof client.toObject === 'function'
      ? client.toObject()
      : client
    : null;
  if (lean && !user?.isLifetimeAdmin && user?.role !== 'SUPER_ADMIN') {
    const repaired = await repairActiveTrialFlags(lean);
    if (repaired) {
      client = repaired;
      lean.trialActive = repaired.trialActive ?? true;
      lean.trialEndsAt = repaired.trialEndsAt;
    }
  }
  const isAdminBypass = user?.role === 'SUPER_ADMIN' || user?.isLifetimeAdmin === true;
  const onboardingCompleted = computeClientOnboardingCompleted(isAdminBypass, client || lean);
  const access = await workspaceAccessForResponse(user, client || lean);

  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    isLifetimeAdmin: user.isLifetimeAdmin,
    business_type: user.business_type || 'ecommerce',
    clientId: user.clientId,
    clientName: client?.name || lean?.name || null,
    subscriptionPlan: user.isLifetimeAdmin ? 'enterprise' : (client?.tier || lean?.tier || 'v1'),
    plan: user.isLifetimeAdmin ? 'Enterprise AI' : (client?.plan || lean?.plan || 'CX Agent (V1)'),
    hasCompletedTour: user.hasCompletedTour,
    hubAccess: Array.isArray(user.hubAccess) ? user.hubAccess : [],
    phone: user.phone || null,
    telemetryConsent: user.telemetryConsent || '',
    telemetryConsentUpdatedAt: user.telemetryConsentUpdatedAt || null,
    trialActive: client?.trialActive ?? lean?.trialActive ?? true,
    trialEndsAt: client?.trialEndsAt ?? lean?.trialEndsAt ?? null,
    manuallySuspended: access.manuallySuspended,
    trialWindowActive: access.trialWindowActive,
    hasPaidAccess: access.hasPaidAccess,
    dashboardLocked: access.dashboardLocked,
    workspaceAccess: access,
    onboardingCompleted,
    onboardingStep: client?.onboardingStep ?? lean?.onboardingStep ?? 0,
    onboardingSkipped: !!(client?.onboardingSkipped ?? lean?.onboardingSkipped),
    onboardingSkippedAt: client?.onboardingSkippedAt ?? lean?.onboardingSkippedAt ?? null,
    onboardingData: client?.onboardingData || lean?.onboardingData || {},
    clientConfig: lean || {},
    clientTemplates: lean?.config?.templates || client?.config?.templates || null,
    isNewUser: onboardingCompleted === false
  };
}

/** Grandfathered clients may omit onboardingCompleted; missing Client doc means not onboarded. */
function computeClientOnboardingCompleted(isAdminBypass, client) {
  if (isAdminBypass) return true;
  if (!client) return false;
  const raw = client.onboardingCompleted;
  return raw === undefined || raw === null ? true : !!raw;
}

// ✅ Phase R4: Simple in-memory OTP rate limiter — max 3 sends per email per hour
// Uses Map<email, { count, windowStart }> — resets after 1 hour
const otpRateLimiter = new Map();
function checkOtpRateLimit(email) {
  const now = Date.now();
  const WINDOW = 60 * 60 * 1000; // 1 hour
  const MAX = 3;
  const entry = otpRateLimiter.get(email);
  if (entry) {
    if (now - entry.windowStart < WINDOW) {
      if (entry.count >= MAX) return false; // blocked
      entry.count++;
      return true;
    }
  }
  // New window
  otpRateLimiter.set(email, { count: 1, windowStart: now });
  return true;
}

const generateToken = (id, clientId, role) => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not configured');
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  return jwt.sign(
    { id, clientId, role },
    process.env.JWT_SECRET,
    { expiresIn }
  );
};

function getGoogleOAuthStateSecret() {
  return (
    process.env.GOOGLE_OAUTH_STATE_SECRET ||
    process.env.JWT_SECRET ||
    process.env.GOOGLE_CLIENT_SECRET ||
    ''
  );
}

function signGoogleOAuthState(payload) {
  const secret = getGoogleOAuthStateSecret();
  if (!secret) return '';
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

function verifyGoogleOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const secret = getGoogleOAuthStateSecret();
  if (!secret) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (_) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch (_) {
    return null;
  }
}

router.get('/me', protect, sanitizeMiddleware, async (req, res) => {
  try {
    let user = await User.findById(req.user.id);
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    await ensureClientForUser(user);

    user = applyBootstrapSuperAdmin(user);
    if (user.isModified?.()) await user.save();

    let client = await Client.findOne({ clientId: user.clientId });

    // --- PHASE 10 ROBUSTNESS: Ensure fallback for missing client ---
    const clientConfig = client ? client.toObject() : {};
    const access = await workspaceAccessForResponse(user, client);

    res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isLifetimeAdmin: user.isLifetimeAdmin,
        business_type: 'ecommerce',
        clientId: user.clientId,
        clientName: client ? client.name : null,
        subscriptionPlan: user.isLifetimeAdmin ? 'enterprise' : (client ? client.tier || 'v1' : 'v1'),
        plan: client ? client.plan || 'CX Agent (V1)' : 'CX Agent (V1)',
        hasCompletedTour: user.hasCompletedTour,
        hubAccess: Array.isArray(user.hubAccess) ? user.hubAccess : [],
        phone: user.phone || null,
        trialActive: client ? client.trialActive : null,
        trialEndsAt: client ? client.trialEndsAt : null,
        manuallySuspended: access.manuallySuspended,
        trialWindowActive: access.trialWindowActive,
        hasPaidAccess: access.hasPaidAccess,
        dashboardLocked: access.dashboardLocked,
        // Phase 32: New-user onboarding gate fields
        onboardingCompleted: computeClientOnboardingCompleted(
          user.role === 'SUPER_ADMIN' || user.isLifetimeAdmin === true,
          client
        ),
        onboardingStep: client ? (client.onboardingStep || 0) : 0,
        onboardingSkipped: !!(client && client.onboardingSkipped),
        onboardingSkippedAt: client?.onboardingSkippedAt ?? null,
        onboardingData: client ? (client.onboardingData || {}) : {},
        clientConfig,
        clientTemplates: client?.config?.templates || null
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// ✅ Phase 2: The Global Bootstrap Endpoint
// Collapses 5 separate network constraints into a single parallel payload
const BOOTSTRAP_CLIENT_SELECT =
  'clientId businessName businessLogo name ai.persona adminPhone brand billing isPaidAccount isLifetimeAdmin trialActive trialEndsAt suspendedAt shopDomain phoneNumberId wabaId whatsappToken whatsappConnectionType whatsappConnectionMethod whatsappDisplayPhoneNumber whatsappVerifiedName whatsappCoexistence whatsappQualityRating whatsappWebhookSubscribed shopifyAccessToken shopifyConnectionStatus shopifyInstallLink shopifyStores instagramConnected instagramPageId instagramUsername instagramProfilePic instagramAccessToken instagramTokenExpiry metaAdsConnected commerce social whatsapp config metaAdsToken metaAdAccountId emailUser emailAppPassword metaAppId geminiApiKey openaiApiKey activePaymentGateway razorpayKeyId razorpaySecret cashfreeAppId cashfreeSecretKey faq googleConnected gmailAddress emailMethod gmailRefreshToken gmailAccessToken onboardingCompleted onboardingSkipped onboardingSkippedAt onboardingStep onboardingData wizardCompleted wizardFeatures plan tier platformVars';

function sanitizeClientForBootstrap(client) {
  if (!client) return {};
  const out = { ...client };
  out.hasGmailRefreshToken = !!out.gmailRefreshToken;
  out.hasGmailAccessToken = !!out.gmailAccessToken;
  delete out.gmailRefreshToken;
  delete out.gmailAccessToken;
  return out;
}

router.get('/bootstrap', protect, async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const { getBootstrapPayload } = require('../utils/core/bootstrapCache');
  const { getCachedClient } = require('../utils/core/clientCache');
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const timer = createTimer('GET /auth/bootstrap', req.user?.clientId || '');
  try {
    const clientId = req.user.clientId;
    if (!clientId) {
      timer.finish('400');
      return res.status(400).json({ message: 'User has no clientId. Invalid state.' });
    }

    const payload = await getBootstrapPayload(String(req.user.id), { refresh }, async () => {
    timer.checkpoint('bootstrap_cache_miss');
    let user = await User.findById(req.user.id).select(
      'name email role clientId isLifetimeAdmin hasCompletedTour telemetryConsent telemetryConsentUpdatedAt hubAccess phone'
    );
    if (!user) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }

    let client = await getCachedClient(clientId, BOOTSTRAP_CLIENT_SELECT);
    if (!client) {
      await ensureClientForUser(user);
      client = await getCachedClient(clientId, BOOTSTRAP_CLIENT_SELECT);
    }
    const isAdminBypassEarly =
      user.role === 'SUPER_ADMIN' || user.isLifetimeAdmin === true;
    if (client && !isAdminBypassEarly) {
      client = await repairActiveTrialFlags(client);
    }
    timer.checkpoint('client_loaded');

    // Phase 32: Onboarding gate — SUPER_ADMIN + lifetime admins bypass.
    // For all other users, `onboardingCompleted === undefined` on an existing
    // (grandfathered) client means they are already onboarded — treat as true.
    const isAdminBypass =
      user.role === 'SUPER_ADMIN' || user.isLifetimeAdmin === true;
    const onboardingCompleted = computeClientOnboardingCompleted(isAdminBypass, client);
    const access = await workspaceAccessForResponse(user, client);

    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        clientId: user.clientId,
        isLifetimeAdmin: user.isLifetimeAdmin,
        hasCompletedTour: user.hasCompletedTour,
        telemetryConsent: user.telemetryConsent || '',
        telemetryConsentUpdatedAt: user.telemetryConsentUpdatedAt || null,
        hubAccess: Array.isArray(user.hubAccess) ? user.hubAccess : [],
        phone: user.phone || null,
        business_type: 'ecommerce',
        manuallySuspended: access.manuallySuspended,
        trialWindowActive: access.trialWindowActive,
        hasPaidAccess: access.hasPaidAccess,
        dashboardLocked: access.dashboardLocked,
        onboardingCompleted,
        onboardingStep: client?.onboardingStep || 0,
        onboardingSkipped: !!(client && client.onboardingSkipped),
        onboardingSkippedAt: client?.onboardingSkippedAt ?? null
      },
      workspaceAccess: access,
      client: sanitizeClientForBootstrap(client),
      // Inbox + today stats moved to /api/dashboard/summary (bootstrap was 15–25s with counts)
      inbox: { unreadCount: 0, recentConversations: [] },
      stats: { msg: 0, leads: 0, rev: 0, active: 0 }
    };
    });

    timer.finish('200 ok');
    res.json(payload);

  } catch (error) {
    console.error('[Bootstrap Error]:', error);
    const code = error.statusCode || 500;
    timer.finish(`${code} ${error.message}`);
    res.status(code).json({ message: error.message || 'Server Error during bootstrap' });
  }
});

router.patch('/me', protect, async (req, res) => {
  try {
    const { hasCompletedTour, telemetryConsent, phone: rawPhone } = req.body;
    const { normalizeIndianPhone } = require('../utils/core/normalizeIndianPhone');
    const { invalidateBootstrapCache } = require('../utils/core/bootstrapCache');
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (hasCompletedTour !== undefined) {
      user.hasCompletedTour = hasCompletedTour;
    }

    if (telemetryConsent !== undefined) {
      const allowed = ['', 'essential', 'analytics'];
      if (!allowed.includes(telemetryConsent)) {
        return res.status(400).json({ success: false, message: 'Invalid telemetry consent value' });
      }
      user.telemetryConsent = telemetryConsent;
      user.telemetryConsentUpdatedAt = new Date();
    }

    if (rawPhone !== undefined && !user.phone) {
      const trimmed = rawPhone == null ? '' : String(rawPhone).trim();
      if (trimmed) {
        const normalized = normalizeIndianPhone(trimmed);
        if (!normalized) {
          return res.status(400).json({
            success: false,
            message: 'Invalid WhatsApp number. Use a 10-digit Indian mobile number.',
            code: 'INVALID_PHONE',
          });
        }
        user.phone = normalized;
      }
    }
    
    await user.save();
    invalidateBootstrapCache(user._id);
    res.json({
      success: true,
      user: {
        _id: user._id,
        hasCompletedTour: user.hasCompletedTour,
        phone: user.phone || null,
        telemetryConsent: user.telemetryConsent || '',
        telemetryConsentUpdatedAt: user.telemetryConsentUpdatedAt,
      },
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

router.post('/login', sanitizeMiddleware, async (req, res) => {
  const emailRaw = req.body?.email;
  const password = req.body?.password;
  const email = String(emailRaw || '')
    .toLowerCase()
    .trim();

  if (!email || !password) {
    return res.status(400).json({
      message: 'Email and password are required.',
      code: 'MISSING_CREDENTIALS'
    });
  }

  try {
    let user = await User.findOne({ email });

    if (!user) {
      auditSecurity('AUTH_LOGIN_FAILED', { req, email, reason: 'user_not_found' });
      auditLog({
        category: 'auth',
        action: 'login_failed',
        severity: 'warning',
        clientId: 'unknown',
        actor: { type: 'user', source: 'auth', ip: req.ip },
        details: { email, reason: 'user_not_found' },
      });
      return res.status(401).json({
        message: 'Invalid email or password.',
        code: 'INVALID_CREDENTIALS'
      });
    }

    // Google-only accounts store a random bcrypt hash — password login will never match.
    if (user.authProvider === 'google') {
      return res.status(401).json({
        message:
          'This account uses Google sign-in. Click “Continue with Google” on the login page, or use Forgot password to add a password.',
        code: 'USE_GOOGLE_LOGIN'
      });
    }

    if (isLocked(user)) {
      return res.status(423).json({
        message: 'Account temporarily locked. Try again later or reset your password.',
        code: 'ACCOUNT_LOCKED',
        lockedUntil: user.lockedUntil,
      });
    }

    if (await user.matchPassword(password)) {
      user = clearFailedAttempts(user);
      user = applyBootstrapSuperAdmin(user);
      await user.save();

      if (
        user.twoFactorEnabled &&
        ['CLIENT_ADMIN', 'SUPER_ADMIN'].includes(user.role)
      ) {
        const challengeToken = jwt.sign(
          { id: user._id, purpose: '2fa_challenge' },
          process.env.JWT_SECRET,
          { expiresIn: '5m' }
        );
        return res.json({ requiresTwoFactor: true, challengeToken });
      }

      auditLog({
        category: 'auth',
        action: 'login_success',
        clientId: user.clientId,
        actor: { type: 'user', userId: user._id, source: 'auth', ip: req.ip },
        details: { email },
      });
      await ensureClientForUser(user);
      const client = await Client.findOne({ clientId: user.clientId });
      const session = await buildAuthSessionPayload(user, client);
      res.json({
        ...session,
        token: generateToken(user._id, user.clientId, user.role),
      });
    } else {
      user = recordFailedAttempt(user);
      await user.save();
      auditSecurity('AUTH_LOGIN_FAILED', { req, email, reason: 'wrong_password' });
      auditLog({
        category: 'auth',
        action: 'login_failed',
        severity: 'warning',
        clientId: user.clientId,
        actor: { type: 'user', userId: user._id, source: 'auth', ip: req.ip },
        details: { email, reason: 'wrong_password' },
      });
      res.status(401).json({
        message: 'Invalid email or password.',
        code: 'INVALID_CREDENTIALS'
      });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

router.post('/register', async (req, res) => {
  const { name, email, password, businessName, otp, acceptLegal, docsVersion, phone: rawPhone } = req.body;
  const mongoose = require('mongoose');
  const { normalizeIndianPhone } = require('../utils/core/normalizeIndianPhone');

  if (!acceptLegal) {
    return res.status(400).json({
      message: 'You must agree to the Privacy Policy and Terms of Service to create an account.',
      code: 'LEGAL_ACCEPTANCE_REQUIRED'
    });
  }
  const dv = docsVersion ? String(docsVersion) : '';
  if (dv !== LEGAL_DOCS_VERSION) {
    return res.status(400).json({
      message: 'Legal documents were updated. Please refresh the signup page and try again.',
      code: 'LEGAL_VERSION_MISMATCH'
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userExists = await User.findOne({ email }).session(session);
    if (userExists) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'User already exists' });
    }

    if (!businessName || !email || !password || !otp) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'All fields including OTP are required' });
    }
    const passwordValidation = validateStrongPassword(password);
    if (!passwordValidation.valid) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: passwordValidation.message, code: 'WEAK_PASSWORD' });
    }

    const displayName = (name && String(name).trim()) || businessName.trim();

    let phone = null;
    if (rawPhone != null && String(rawPhone).trim()) {
      phone = normalizeIndianPhone(rawPhone);
      if (!phone) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          message: 'Invalid WhatsApp number. Use a 10-digit Indian mobile number.',
          code: 'INVALID_PHONE',
        });
      }
    }

    // -- OTP Verification --
    const validOtp = await OTP.findOne({ email, otp, purpose: 'SIGNUP' }).session(session);
    if (!validOtp) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Invalid or expired OTP.' });
    }
    // Delete OTP so it can't be reused
    await OTP.deleteOne({ _id: validOtp._id }).session(session);

    // Generate unique clientId from business name + random hex
    const crypto = require('crypto');
    const safeName = businessName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const uniqueId = crypto.randomBytes(3).toString('hex');
    const newClientId = `${safeName}_${uniqueId}`;

    // Product scope: e-commerce only
    const chosenType = 'ecommerce';

    // 1. Create the Client (Trial mode default: 14 Days)
    const newClient = await Client.create([{
      clientId: newClientId,
      businessName: businessName,
      name: businessName,
      isActive: true,
      trialActive: true,
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // Extended to 14 days
      plan: 'CX Agent (V1)',
      businessType: chosenType,
      flowNodes: [],
      flowEdges: [],
      // Phase 32: force new users through full-screen onboarding before dashboard
      onboardingCompleted: false,
      onboardingStep: 0,
      onboardingData: { brandName: businessName }
    }], { session });

    // 2. Create the User linked to this new Client
    const user = await User.create([{
      name: displayName,
      email,
      password,
      role: 'CLIENT_ADMIN',
      business_type: chosenType,
      clientId: newClientId,
      legal: { acceptedAt: new Date(), docsVersion: LEGAL_DOCS_VERSION },
      ...(phone ? { phone } : {}),
    }], { session });

    await session.commitTransaction();
    session.endSession();

    if (user && newClient) {
      const createdUser = user[0];
      let createdClient = await Client.findOne({ clientId: newClientId });
      if (createdClient) {
        createdClient = await provisionNewClientTrial(createdClient);
        try {
          const { enqueueSignupWelcomeJob } = require('../utils/messaging/queues/signupWelcomeQueue');
          enqueueSignupWelcomeJob({
            userId: createdUser._id,
            clientId: newClientId,
          }).catch((err) => {
            log.warn(`[Auth] Signup welcome enqueue failed: ${err.message}`);
          });
        } catch (enqueueErr) {
          log.warn(`[Auth] Signup welcome queue unavailable: ${enqueueErr.message}`);
        }
      }
      const session = await buildAuthSessionPayload(createdUser, createdClient);
      res.status(201).json({
        ...session,
        token: generateToken(createdUser._id, createdUser.clientId, createdUser.role),
        isNewUser: true,
      });
    } else {
      res.status(400).json({ message: 'Failed to create user or client' });
    }
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Registration Error:', error);
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

router.get('/ping', async (_req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// ----------------------------------------------------
// OTP AND PASSWORD CHANGING LOGIC
// ----------------------------------------------------

router.post('/send-otp', async (req, res) => {
  let { email, purpose } = req.body;
  if (!email) return res.status(400).json({ message: 'Email required' });

  email = email.toLowerCase().trim();

  // ✅ Phase R4: Rate limit — max 3 OTP requests per email per hour
  if (!checkOtpRateLimit(email)) {
    return res.status(429).json({ 
      message: 'Too many OTP requests. Please wait 1 hour before requesting again.',
      code: 'OTP_RATE_LIMITED'
    });
  }

  // If purpose is RESET_PASSWORD, ensure user exists
  if (purpose === 'RESET_PASSWORD') {
    const userExists = await User.findOne({ email });
    if (!userExists) return res.status(404).json({ message: 'Account not found' });
  }

  // Clear existing OTPs for this email+purpose to prevent conflicts
  await OTP.deleteMany({ email, purpose: purpose || 'SIGNUP' });

  // Generate 6-digit numeric OTP
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    await OTP.create({ email, otp: otpCode, purpose: purpose || 'SIGNUP' });
    const emailSent = await sendSystemOTPEmail(email, otpCode, purpose);
    
    if (emailSent) {
      res.json({ success: true, message: 'OTP sent successfully' });
    } else {
      console.error(
        '[send-otp] Email delivery failed — Gmail SMTP often times out from cloud hosts (ETIMEDOUT). ' +
          'Fix: set RESEND_API_KEY and verify your domain in Resend, plus RESEND_FROM (e.g. "TopEdge AI <noreply@yourdomain.com>"). ' +
          'Alternatively fix SMTP egress or use a transactional SMTP provider that allows your PaaS IP range.'
      );
      res.status(503).json({
        message:
          'Email could not be sent. On Render, outbound SMTP to Gmail frequently times out; add RESEND_API_KEY (HTTPS) or use SMTP from a provider that allows datacenter egress. See server logs.',
        code: 'EMAIL_UNAVAILABLE'
      });
    }
  } catch (error) {
    console.error('Send OTP Error:', error);
    res.status(500).json({ message: 'Server error generating OTP' });
  }
});

router.post('/change-password', async (req, res) => {
  const { otp, newPassword } = req.body;
  const email = String(req.body?.email || '')
    .toLowerCase()
    .trim();

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ message: 'Email, OTP, and new password are required' });
  }

  const passwordValidation = validateStrongPassword(newPassword);
  if (!passwordValidation.valid) {
    return res.status(400).json({ message: passwordValidation.message, code: 'WEAK_PASSWORD' });
  }

  try {
    const validOtp = await OTP.findOne({ email, otp, purpose: 'RESET_PASSWORD' });
    if (!validOtp) {
      return res.status(400).json({ message: 'Invalid or expired OTP.' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Update password (pre-save hook will hash it). Allow email/password login after OTP reset for Google-created accounts.
    user.password = newPassword;
    user.authProvider = 'email';
    await user.save();

    // Clear OTP
    await OTP.deleteOne({ _id: validOtp._id });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change Password Error:', error);
    res.status(500).json({ message: 'Server error changing password' });
  }
});


// ✅ Phase R4: Authenticated change-password for Settings page
// POST /api/auth/update-password — requires valid JWT, takes currentPassword + newPassword
router.post('/update-password', protect, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Current password and new password are required' });
  }
  const passwordValidation = validateStrongPassword(newPassword);
  if (!passwordValidation.valid) {
    return res.status(400).json({ message: passwordValidation.message, code: 'WEAK_PASSWORD' });
  }

  try {
    // Re-fetch with password field (it's excluded by default in protect middleware)
    const user = await User.findById(req.user._id).select('+password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect', code: 'WRONG_PASSWORD' });
    }

    user.password = newPassword; // pre-save hook hashes it
    await user.save();

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('[Auth] update-password error:', error);
    res.status(500).json({ message: 'Server error updating password' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE OAUTH — Google-Only Auth (no password needed)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/auth/google/oauth-config — Safe diagnostic (no secrets).
 * Use to verify which redirect_uri production sends to Google.
 */
router.get('/google/oauth-config', (req, res) => {
  res.json(getGoogleOAuthPublicConfig());
});

/**
 * GET /api/auth/google/login — Initiate Google OAuth
 * Query: ?mode=login|signup&businessName=X&businessType=Y (signup only)
 */
router.get('/google/login', (req, res) => {
  const { mode, businessName, legalAccepted, docsVersion } = req.query;
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const REDIRECT_URI = getGoogleAuthRedirectUri();

  if (!GOOGLE_CLIENT_ID) {
    console.error('[Google OAuth] Missing GOOGLE_CLIENT_ID in environment variables.');
    return res.status(500).json({ message: 'Google OAuth not configured' });
  }

  if (String(process.env.DEBUG_GOOGLE_OAUTH || '').trim() === '1') {
    console.info('[Google OAuth] login redirect_uri=', REDIRECT_URI);
  }

  // Encode signup data into state parameter (signup requires legal acceptance)
  const statePayload = {
    mode: mode || 'login',
    businessName,
    businessType: 'ecommerce',
    legalAccepted: String(legalAccepted || '') === '1' || String(legalAccepted || '').toLowerCase() === 'true',
    docsVersion: docsVersion ? String(docsVersion) : '',
    iat: Date.now()
  };
  const state = signGoogleOAuthState(statePayload);
  if (!state) {
    return res.status(500).json({ message: 'Google OAuth state signing not configured' });
  }

  const scopes = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ].join(' ');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${encodeURIComponent(state)}` +
    `&prompt=select_account`;

  return res.redirect(authUrl);
});

/**
 * GET /api/auth/google/callback — Handle Google OAuth callback
 * Exchanges code → Google user info → find or create User + Client → redirect with JWT
 */
function googleOAuthFrontendPath(mode, query = '') {
  const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://dash.topedgeai.com').replace(/\/$/, '');
  const base = String(mode || '').toLowerCase() === 'signup' ? `${FRONTEND_URL}/signup` : `${FRONTEND_URL}/login`;
  return query ? `${base}?${query}` : base;
}

router.get('/google/callback', async (req, res) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dash.topedgeai.com';
  let oauthMode = 'login';
  try {
    const { code, state } = req.query;
    const stateDataEarly = verifyGoogleOAuthState(state) || null;
    oauthMode = stateDataEarly?.mode || 'login';

    if (!code) {
      return res.redirect(googleOAuthFrontendPath(oauthMode, 'error=google_auth_failed'));
    }

    // Decode state
    const stateData = stateDataEarly;
    if (!stateData) {
      return res.redirect(googleOAuthFrontendPath(oauthMode, 'error=invalid_state'));
    }
    if (Date.now() - Number(stateData.iat || 0) > 15 * 60 * 1000) {
      return res.redirect(googleOAuthFrontendPath(oauthMode, 'error=invalid_state'));
    }
    oauthMode = stateData.mode || 'login';

    const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    const REDIRECT_URI = getGoogleAuthRedirectUri();
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.redirect(googleOAuthFrontendPath(oauthMode, 'error=google_auth_failed'));
    }

    // Exchange code for tokens
    const axios = require('axios');
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });

    const { id_token, access_token } = tokenRes.data;

    // Get user info from Google
    const userInfoRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const { email, name, picture, sub: googleId, email_verified: emailVerified } = userInfoRes.data;

    if (!email || emailVerified === false) {
      return res.redirect(googleOAuthFrontendPath(oauthMode, 'error=no_email'));
    }

    // Check if user already exists
    let user = await User.findOne({ email: email.toLowerCase() });

    if (user) {
      // ── Existing User: Log them in ─────────────────────────
      // Update Google info if not set
      if (!user.googleId) {
        user.googleId = googleId;
        user.profilePicture = picture;
        user.authProvider = 'google';
        await user.save();
      }

      await ensureClientForUser(user);

      const token = generateToken(user._id, user.clientId, user.role);
      return res.redirect(
        googleOAuthFrontendPath(oauthMode, `google_token=${encodeURIComponent(token)}&google_success=true`)
      );

    } else {
      // ── New User: Auto-create Account ──────────────────────
      // Any new OAuth user must have affirmed current legal docs (signup checkbox or login browsewrap URL params).
      if (
        !stateData.legalAccepted ||
        String(stateData.docsVersion || '') !== LEGAL_DOCS_VERSION
      ) {
        return res.redirect(googleOAuthFrontendPath('signup', 'error=legal_required'));
      }
      const crypto = require('crypto');
      const rawBusinessName = String(stateData.businessName || '').trim();
      const businessName = rawBusinessName || (name ? `${name}'s Business` : 'My Business');
      const businessType = 'ecommerce';
      const safeName = businessName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const uniqueId = crypto.randomBytes(3).toString('hex');
      const newClientId = `${safeName}_${uniqueId}`;

      // Create Client
      const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const googleClient = await Client.create({
        clientId: newClientId,
        businessName,
        name: businessName,
        isActive: true,
        trialActive: true,
        trialEndsAt,
        plan: 'CX Agent (V1)',
        businessType,
        flowNodes: [],
        flowEdges: [],
        onboardingCompleted: false,
        onboardingStep: 0,
        onboardingData: { brandName: businessName }
      });
      await provisionNewClientTrial(googleClient);

      // Create User (no password — Google-only auth)
      user = await User.create({
        name,
        email: email.toLowerCase(),
        password: crypto.randomBytes(32).toString('hex'), // Random password — user never uses it
        role: 'CLIENT_ADMIN',
        business_type: businessType,
        clientId: newClientId,
        googleId,
        profilePicture: picture,
        authProvider: 'google',
        legal: { acceptedAt: new Date(), docsVersion: LEGAL_DOCS_VERSION }
      });

      const token = generateToken(user._id, user.clientId, user.role);
      return res.redirect(
        googleOAuthFrontendPath(
          'signup',
          `google_token=${encodeURIComponent(token)}&google_success=true&new_user=true`
        )
      );
    }
  } catch (error) {
    console.error('[Google OAuth] Callback error:', error.response?.data || error.message);
    return res.redirect(googleOAuthFrontendPath(oauthMode, 'error=google_auth_failed'));
  }
});

const {
  generateSecret,
  verifyTotp,
  otpauthUrl,
  hashRecoveryCodes,
  consumeRecoveryCode,
  generateRecoveryCodes,
} = require('../utils/auth/twoFactor');

router.post('/2fa/setup', protect, async (req, res) => {
  if (!['CLIENT_ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
    return res.status(403).json({ message: '2FA not available for this role' });
  }
  const secret = generateSecret();
  req.user.twoFactorSecret = secret;
  await req.user.save();
  res.json({
    secret,
    otpauthUrl: otpauthUrl(req.user.email, secret),
    qrHint: 'Scan with Google Authenticator or Authy',
  });
});

router.post('/2fa/verify', protect, async (req, res) => {
  const { code } = req.body;
  if (!verifyTotp(req.user.twoFactorSecret, code)) {
    return res.status(400).json({ message: 'Invalid code' });
  }
  const plainCodes = generateRecoveryCodes();
  req.user.twoFactorEnabled = true;
  req.user.twoFactorRecoveryCodes = await hashRecoveryCodes(plainCodes);
  await req.user.save();
  auditLog({
    category: 'auth',
    action: '2fa_enabled',
    clientId: req.user.clientId,
    actor: { type: 'user', userId: req.user._id, source: 'auth' },
  });
  res.json({ success: true, recoveryCodes: plainCodes });
});

router.post('/2fa/challenge', async (req, res) => {
  const { challengeToken, code, recoveryCode } = req.body;
  if (!challengeToken) return res.status(400).json({ message: 'challengeToken required' });
  let decoded;
  try {
    decoded = jwt.verify(challengeToken, process.env.JWT_SECRET);
    if (decoded.purpose !== '2fa_challenge') throw new Error('invalid');
  } catch {
    return res.status(401).json({ message: 'Invalid or expired challenge' });
  }
  const user = await User.findById(decoded.id);
  if (!user?.twoFactorEnabled) return res.status(400).json({ message: '2FA not enabled' });
  let ok = false;
  if (recoveryCode) {
    ok = await consumeRecoveryCode(user, recoveryCode);
    if (ok) {
      auditLog({
        category: 'auth',
        action: '2fa_recovery_used',
        clientId: user.clientId,
        actor: { type: 'user', userId: user._id, source: 'auth' },
      });
    }
  } else {
    ok = verifyTotp(user.twoFactorSecret, code);
  }
  if (!ok) return res.status(401).json({ message: 'Invalid 2FA code' });
  await user.save();
  auditLog({
    category: 'auth',
    action: 'login_success',
    clientId: user.clientId,
    actor: { type: 'user', userId: user._id, source: 'auth_2fa' },
  });
  const client = await Client.findOne({ clientId: user.clientId });
  const session = await buildAuthSessionPayload(user, client);
  res.json({ ...session, token: generateToken(user._id, user.clientId, user.role) });
});

module.exports = router;
