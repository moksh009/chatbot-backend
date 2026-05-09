const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Client = require('../models/Client');
const OTP = require('../models/OTP'); // Added OTP Model
const { protect } = require('../middleware/auth');
const { sanitizeMiddleware } = require('../utils/sanitize');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); // ✅ Phase R4: for authenticated change-password
/** Node Crypto (HMAC state signing). Do not rely on global `crypto` — Node 19+ exposes Web Crypto globally without createHmac. */
const crypto = require('crypto');
const { sendSystemOTPEmail } = require('../utils/emailService');
const { ensureClientForUser } = require('../utils/ensureClientForUser');
const { LEGAL_DOCS_VERSION } = require('../config/legalDocs');
const { validateStrongPassword } = require('../utils/passwordPolicy');
const { getAccessForUserClient } = require('../utils/accessFlags');

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
  return jwt.sign(
    { id, clientId, role }, // ✅ Phase R4: Include clientId + role in token payload
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
};

/**
 * Must exactly match an "Authorized redirect URI" on the same Google OAuth client as GOOGLE_CLIENT_ID.
 * Calendar uses /api/oauth/google/callback — login uses /api/auth/google/callback (add both in Google Cloud Console).
 */
function getGoogleAuthRedirectUri() {
  const explicit = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  if (explicit) return explicit.replace(/\s+/g, '');
  const raw =
    process.env.GOOGLE_OAUTH_BACKEND_URL ||
    process.env.SERVER_URL ||
    process.env.BACKEND_URL ||
    process.env.API_BASE ||
    '';
  let base = String(raw).trim().replace(/\/$/, '');
  if (!base) base = 'https://chatbot-backend-lg5y.onrender.com';
  if (!/^https:\/\//i.test(base)) {
    base = `https://${base.replace(/^https?:\/\//i, '')}`;
  }
  return `${base}/api/auth/google/callback`;
}

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

    // Admin Booster: Ensure admin@topedgeai.com is always Super Admin
    if (user.email === 'admin@topedgeai.com') {
      if (user.role !== 'SUPER_ADMIN' || !user.isLifetimeAdmin) {
        user.role = 'SUPER_ADMIN';
        user.isLifetimeAdmin = true;
        await user.save();
      }
    }

    let client = await Client.findOne({ clientId: user.clientId });

    // Delitech demotion: Land on normal dashboard but keep best plan
    if (user.email === 'delitech2708@gmail.com') {
      if (user.role === 'SUPER_ADMIN') {
        user.role = 'CLIENT_ADMIN';
      }
      user.isLifetimeAdmin = true;
      await user.save();

      // Ensure client is also lifetime admin
      if (client && !client.isLifetimeAdmin) {
        client.isLifetimeAdmin = true;
        client.plan = 'CX Agent (V2)'; // Give the best plan
        client.tier = 'v2';
        await client.save();
      }
    }

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
router.get('/bootstrap', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    if (!clientId) {
       return res.status(400).json({ message: 'User has no clientId. Invalid state.' });
    }

    let user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    await ensureClientForUser(user);

    const { startOfDayIST } = require('../utils/queryHelpers');
    const dayStart = startOfDayIST();
    
    // Import required models
    const Message = require('../models/Message');
    const AdLead = require('../models/AdLead');
    const Order = require('../models/Order');
    const Conversation = require('../models/Conversation');

    // Run all database fetches in parallel
    const [client, unreadCount, todayStats, recentConversations] = await Promise.all([
      // 1. Client settings + User
      Client.findOne({ clientId })
        .select('clientId businessName name ai.persona adminPhone brand billing isPaidAccount isLifetimeAdmin trialActive trialEndsAt suspendedAt shopDomain phoneNumberId wabaId whatsappToken shopifyAccessToken shopifyConnectionStatus shopifyInstallLink instagramConnected instagramPageId instagramUsername instagramProfilePic instagramAccessToken instagramTokenExpiry metaAdsConnected commerce social whatsapp config visualFlows metaAdsToken metaAdAccountId emailUser emailAppPassword metaAppId geminiApiKey openaiApiKey activePaymentGateway razorpayKeyId razorpaySecret cashfreeAppId cashfreeSecretKey faq googleConnected gmailAddress emailMethod onboardingCompleted onboardingSkipped onboardingSkippedAt onboardingStep onboardingData wizardCompleted plan tier')
        .lean()
        .then(c => {
          if (!c) return null;
          try {
            return {
              ...c,
              visualFlows: (c.visualFlows || []).map(f => ({
                id: f.id, name: f.name, platform: f.platform, isActive: f.isActive, nodeCount: f.nodeCount
              }))
            };
          } catch (transformErr) {
            console.error('[Bootstrap] Client transform error:', transformErr.message);
            return c; // Return raw client data if transform fails
          }
        }),
      
      // 2. Unread Count across all chats
      Conversation.countDocuments({ clientId, unreadCount: { $gt: 0 } }),
      
      // 3. Today's Snapshot Stats (Messages, Leads, Rev, Active Bots)
      (async () => {
        try {
          const [msg, leads, active] = await Promise.all([
            Message.countDocuments({ clientId, timestamp: { $gte: dayStart } }),
            AdLead.countDocuments({ clientId, createdAt: { $gte: dayStart } }),
            Conversation.countDocuments({ clientId, status: 'BOT_ACTIVE' })
          ]);
          
          const revResult = await Order.aggregate([
            { $match: { clientId, createdAt: { $gte: dayStart } } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
          ]);
          const rev = revResult[0]?.total || 0;
          return { msg, leads, rev, active };
        } catch { return { msg: 0, leads: 0, rev: 0, active: 0 }; }
      })(),
      
      // 4. Quick inbox summary
      Conversation.find({ clientId })
        .sort({ lastMessageAt: -1 })
        .limit(25)
        .select('phone customerName lastMessage lastMessageAt status unreadCount botPaused channel requiresAttention')
        .lean()
    ]);

    // Admin/Delitech role syncing logic from /me
    if (user.email === 'admin@topedgeai.com' && (!user.isLifetimeAdmin || user.role !== 'SUPER_ADMIN')) {
      user.role = 'SUPER_ADMIN'; user.isLifetimeAdmin = true; await user.save();
    }
    if (user.email === 'delitech2708@gmail.com') {
      if (user.role === 'SUPER_ADMIN') user.role = 'CLIENT_ADMIN';
      user.isLifetimeAdmin = true; await user.save();
    }

    // Phase 32: Onboarding gate — SUPER_ADMIN + lifetime admins bypass.
    // For all other users, `onboardingCompleted === undefined` on an existing
    // (grandfathered) client means they are already onboarded — treat as true.
    const isAdminBypass =
      user.role === 'SUPER_ADMIN' || user.isLifetimeAdmin === true;
    const onboardingCompleted = computeClientOnboardingCompleted(isAdminBypass, client);
    const access = await workspaceAccessForResponse(user, client);

    res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        clientId: user.clientId,
        isLifetimeAdmin: user.isLifetimeAdmin,
        hasCompletedTour: user.hasCompletedTour,
        business_type: 'ecommerce',
        manuallySuspended: access.manuallySuspended,
        trialWindowActive: access.trialWindowActive,
        hasPaidAccess: access.hasPaidAccess,
        dashboardLocked: access.dashboardLocked,
        // Phase 32: surfaced at top-level user for quick guard checks
        onboardingCompleted,
        onboardingStep: client?.onboardingStep || 0,
        onboardingSkipped: !!(client && client.onboardingSkipped),
        onboardingSkippedAt: client?.onboardingSkippedAt ?? null
      },
      workspaceAccess: access,
      client: client || {},
      inbox: { unreadCount, recentConversations },
      stats: todayStats
    });

  } catch (error) {
    console.error('[Bootstrap Error]:', error);
    res.status(500).json({ message: 'Server Error during bootstrap' });
  }
});

router.patch('/me', protect, async (req, res) => {
  try {
    const { hasCompletedTour } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (hasCompletedTour !== undefined) {
      user.hasCompletedTour = hasCompletedTour;
    }
    
    await user.save();
    res.json({ success: true, user });
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

    // Admin Booster
    if (user && user.email === 'admin@topedgeai.com') {
      if (user.role !== 'SUPER_ADMIN' || !user.isLifetimeAdmin) {
        user.role = 'SUPER_ADMIN';
        user.isLifetimeAdmin = true;
        await user.save();
      }
    }

    // Delitech demotion
    if (user && user.email === 'delitech2708@gmail.com') {
      if (user.role === 'SUPER_ADMIN') {
        user.role = 'CLIENT_ADMIN';
      }
      user.isLifetimeAdmin = true;
      await user.save();
      
      // Also sync client status
      const client = await Client.findOne({ clientId: user.clientId });
      if (client && !client.isLifetimeAdmin) {
        client.isLifetimeAdmin = true;
        client.plan = 'CX Agent (V2)';
        client.tier = 'v2';
        await client.save();
      }
    }

    if (!user) {
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

    if (await user.matchPassword(password)) {
      await ensureClientForUser(user);
      const client = await Client.findOne({ clientId: user.clientId });

      const isAdminBypass =
        user.role === 'SUPER_ADMIN' || user.isLifetimeAdmin === true;
      const onboardingCompleted = computeClientOnboardingCompleted(isAdminBypass, client);
      const access = await workspaceAccessForResponse(user, client);

      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isLifetimeAdmin: user.isLifetimeAdmin,
        business_type: 'ecommerce',
        clientId: user.clientId,
        token: generateToken(user._id, user.clientId, user.role), // ✅ Phase R4: clientId+role in JWT
        clientName: client ? client.name : null,
        subscriptionPlan: user.isLifetimeAdmin ? 'enterprise' : (client ? client.tier || 'v1' : 'v1'),
        plan: user.isLifetimeAdmin ? 'Enterprise AI' : (client ? client.plan || 'CX Agent (V1)' : 'CX Agent (V1)'),
        hasCompletedTour: user.hasCompletedTour,
        trialActive: client ? client.trialActive : null,
        trialEndsAt: client ? client.trialEndsAt : null,
        manuallySuspended: access.manuallySuspended,
        trialWindowActive: access.trialWindowActive,
        hasPaidAccess: access.hasPaidAccess,
        dashboardLocked: access.dashboardLocked,
        workspaceAccess: access,
        // Phase 32
        onboardingCompleted,
        onboardingStep: client?.onboardingStep || 0,
        onboardingSkipped: !!(client && client.onboardingSkipped),
        onboardingSkippedAt: client?.onboardingSkippedAt ?? null,
        onboardingData: client?.onboardingData || {},
        clientConfig: client ? client.toObject() : {},
        clientTemplates: client && client.config && client.config.templates ? client.config.templates : null
      });
    } else {
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
  const { name, email, password, businessName, otp, acceptLegal, docsVersion } = req.body;
  const mongoose = require('mongoose');

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
      legal: { acceptedAt: new Date(), docsVersion: LEGAL_DOCS_VERSION }
    }], { session });

    await session.commitTransaction();
    session.endSession();

    if (user && newClient) {
      res.status(201).json({
        _id: user[0]._id,
        name: user[0].name,
        email: user[0].email,
        role: user[0].role,
        business_type: user[0].business_type,
        clientId: user[0].clientId,
        token: generateToken(user[0]._id, user[0].clientId, user[0].role),
        // Phase 32: signal the frontend to route straight to /onboarding
        onboardingCompleted: false,
        onboardingStep: 0,
        isNewUser: true
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
router.get('/google/callback', async (req, res) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dash.topedgeai.com';
  try {
    const { code, state } = req.query;
    if (!code) {
      return res.redirect(`${FRONTEND_URL}/login?error=google_auth_failed`);
    }

    // Decode state
    const stateData = verifyGoogleOAuthState(state) || null;
    if (!stateData) {
      return res.redirect(`${FRONTEND_URL}/login?error=invalid_state`);
    }
    if (Date.now() - Number(stateData.iat || 0) > 15 * 60 * 1000) {
      return res.redirect(`${FRONTEND_URL}/login?error=invalid_state`);
    }

    const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    const REDIRECT_URI = getGoogleAuthRedirectUri();
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.redirect(`${FRONTEND_URL}/login?error=google_auth_failed`);
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
      return res.redirect(`${FRONTEND_URL}/login?error=no_email`);
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
      return res.redirect(`${FRONTEND_URL}/login?google_token=${token}&google_success=true`);

    } else {
      // ── New User: Auto-create Account ──────────────────────
      // Any new OAuth user must have affirmed current legal docs (signup checkbox or login browsewrap URL params).
      if (
        !stateData.legalAccepted ||
        String(stateData.docsVersion || '') !== LEGAL_DOCS_VERSION
      ) {
        return res.redirect(`${FRONTEND_URL}/signup?error=legal_required`);
      }
      const crypto = require('crypto');
      const businessName = stateData.businessName || name + "'s Business";
      const businessType = 'ecommerce';
      const safeName = businessName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const uniqueId = crypto.randomBytes(3).toString('hex');
      const newClientId = `${safeName}_${uniqueId}`;

      // Create Client
      await Client.create({
        clientId: newClientId,
        businessName,
        name: businessName,
        isActive: true,
        trialActive: true,
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        plan: 'CX Agent (V1)',
        businessType,
        flowNodes: [],
        flowEdges: [],
        // Phase 32: force new Google users through full-screen onboarding
        onboardingCompleted: false,
        onboardingStep: 0,
        onboardingData: { brandName: businessName }
      });

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
      return res.redirect(`${FRONTEND_URL}/login?google_token=${token}&google_success=true&new_user=true`);
    }
  } catch (error) {
    console.error('[Google OAuth] Callback error:', error.response?.data || error.message);
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dash.topedgeai.com';
    return res.redirect(`${FRONTEND_URL}/login?error=google_auth_failed`);
  }
});

module.exports = router;
