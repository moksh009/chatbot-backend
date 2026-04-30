const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Client = require('../models/Client');
const OTP = require('../models/OTP'); // Added OTP Model
const { protect } = require('../middleware/auth');
const { sanitizeMiddleware } = require('../utils/sanitize');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); // ✅ Phase R4: for authenticated change-password
const { sendSystemOTPEmail } = require('../utils/emailService');

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
  return jwt.sign(
    { id, clientId, role }, // ✅ Phase R4: Include clientId + role in token payload
    process.env.JWT_SECRET || 'fallback_secret_dev',
    { expiresIn: '30d' }
  );
};

router.get('/me', protect, sanitizeMiddleware, async (req, res) => {
  try {
    let user = await User.findById(req.user.id);
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    // Admin Booster: Ensure admin@topedgeai.com is always Super Admin
    if (user.email === 'admin@topedgeai.com') {
      if (user.role !== 'SUPER_ADMIN' || !user.isLifetimeAdmin) {
        user.role = 'SUPER_ADMIN';
        user.isLifetimeAdmin = true;
        await user.save();
      }
    }

    const client = await Client.findOne({ clientId: user.clientId });

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

    res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isLifetimeAdmin: user.isLifetimeAdmin,
        business_type: client ? client.businessType || user.business_type : user.business_type,
        clientId: user.clientId,
        clientName: client ? client.name : null,
        subscriptionPlan: user.isLifetimeAdmin ? 'enterprise' : (client ? client.tier || 'v1' : 'v1'),
        plan: client ? client.plan || 'CX Agent (V1)' : 'CX Agent (V1)',
        hasCompletedTour: user.hasCompletedTour,
        trialActive: client ? client.trialActive : null,
        trialEndsAt: client ? client.trialEndsAt : null,
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
        .select('clientId businessName name ai.persona adminPhone brand billing trialActive trialEndsAt shopDomain phoneNumberId wabaId whatsappToken shopifyAccessToken shopifyConnectionStatus instagramConnected commerce social whatsapp config visualFlows metaAdsToken metaAdAccountId emailUser emailAppPassword metaAppId geminiApiKey openaiApiKey activePaymentGateway razorpayKeyId razorpaySecret cashfreeAppId cashfreeSecretKey faq')
        .lean()
        .then(c => {
          if (!c) return null;
          return {
            ...c,
            visualFlows: (c.visualFlows || []).map(f => ({
              id: f.id, name: f.name, platform: f.platform, isActive: f.isActive, nodeCount: f.nodeCount
            }))
          };
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
    let user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.email === 'admin@topedgeai.com' && (!user.isLifetimeAdmin || user.role !== 'SUPER_ADMIN')) {
      user.role = 'SUPER_ADMIN'; user.isLifetimeAdmin = true; await user.save();
    }
    if (user.email === 'delitech2708@gmail.com') {
      if (user.role === 'SUPER_ADMIN') user.role = 'CLIENT_ADMIN';
      user.isLifetimeAdmin = true; await user.save();
    }

    res.json({
      user: { 
        id: user._id, 
        name: user.name, 
        email: user.email, 
        role: user.role, 
        clientId: user.clientId, 
        isLifetimeAdmin: user.isLifetimeAdmin,
        hasCompletedTour: user.hasCompletedTour,
        business_type: user.business_type
      },
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
  const { email, password } = req.body;

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

    if (user && (await user.matchPassword(password))) {
      // Fetch Client Config
      const client = await Client.findOne({ clientId: user.clientId });
      
      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isLifetimeAdmin: user.isLifetimeAdmin,
        business_type: client ? client.businessType || user.business_type : user.business_type,
        clientId: user.clientId,
        token: generateToken(user._id, user.clientId, user.role), // ✅ Phase R4: clientId+role in JWT
        clientName: client ? client.name : null,
        subscriptionPlan: user.isLifetimeAdmin ? 'enterprise' : (client ? client.tier || 'v1' : 'v1'),
        plan: user.isLifetimeAdmin ? 'Enterprise AI' : (client ? client.plan || 'CX Agent (V1)' : 'CX Agent (V1)'),
        hasCompletedTour: user.hasCompletedTour,
        trialActive: client ? client.trialActive : null,
        trialEndsAt: client ? client.trialEndsAt : null,
        clientConfig: client ? client.toObject() : {},
        clientTemplates: client && client.config && client.config.templates ? client.config.templates : null
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

router.post('/register', async (req, res) => {
  const { name, email, password, businessName, businessType, otp } = req.body;
  const mongoose = require('mongoose');

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userExists = await User.findOne({ email }).session(session);
    if (userExists) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'User already exists' });
    }

    if (!businessName || !name || !email || !password || !otp) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'All fields including OTP are required' });
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

    // Valid business types for client and user models
    const validTypes = ['ecommerce', 'salon', 'turf', 'clinic', 'choice_salon', 'choice_salon_new', 'agency', 'travel', 'real-estate', 'healthcare', 'other'];
    const chosenType = (businessType && validTypes.includes(businessType)) ? businessType : 'other';

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
      flowEdges: []
    }], { session });

    // 2. Create the User linked to this new Client
    const user = await User.create([{
      name,
      email,
      password,
      role: 'CLIENT_ADMIN',
      business_type: chosenType,
      clientId: newClientId
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
      res.status(500).json({ message: 'Failed to send OTP email' });
    }
  } catch (error) {
    console.error('Send OTP Error:', error);
    res.status(500).json({ message: 'Server error generating OTP' });
  }
});

router.post('/change-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ message: 'Email, OTP, and new password are required' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters long' });
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

    // Update password (pre-save hook will hash it)
    user.password = newPassword;
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
  if (newPassword.length < 8) {
    return res.status(400).json({ message: 'New password must be at least 8 characters' });
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

module.exports = router;
