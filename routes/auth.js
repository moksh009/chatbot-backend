const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Client = require('../models/Client');
const OTP = require('../models/OTP'); // Added OTP Model
const { protect } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { sendSystemOTPEmail } = require('../utils/emailService');

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'fallback_secret_dev', {
    expiresIn: '30d',
  });
};

router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    const client = await Client.findOne({ clientId: user.clientId });

    // --- PHASE 10 ROBUSTNESS: Ensure fallback for missing client ---
    const clientConfig = client ? {
      ...(client.config || {}),
      nicheData: client.nicheData || {},
      flowData: client.flowData || {},
      automationFlows: client.automationFlows || [],
      messageTemplates: client.messageTemplates || [],
      flowNodes: client.flowNodes || [],
      flowEdges: client.flowEdges || [],
      syncedMetaFlows: client.syncedMetaFlows || [],
      flowFolders: client.flowFolders || [],
      visualFlows: client.visualFlows || [],
      adminPhone: client.adminPhone || '',
      shopDomain: client.shopDomain || '',
      shopifyAccessToken: client.shopifyAccessToken || '',
      shopifyClientId: client.shopifyClientId || '',
      shopifyClientSecret: client.shopifyClientSecret || '',
      razorpayKeyId: client.razorpayKeyId || '',
      googleReviewUrl: client.googleReviewUrl || '',
      wabaId: client.wabaId || '',
      phoneNumberId: client.phoneNumberId || '',
      whatsappToken: client.whatsappToken || '',
      instagramConnected: client.instagramConnected || false
    } : {
      nicheData: {},
      flowData: {},
      automationFlows: [],
      messageTemplates: [],
      flowNodes: [],
      flowEdges: [],
      syncedMetaFlows: [],
      flowFolders: [],
      visualFlows: []
    };

    res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        business_type: client ? client.businessType || user.business_type : user.business_type,
        clientId: user.clientId,
        clientName: client ? client.name : null,
        subscriptionPlan: client ? client.subscriptionPlan || 'v2' : 'v2',
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

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });

    if (user && (await user.matchPassword(password))) {
      // Fetch Client Config
      const client = await Client.findOne({ clientId: user.clientId });
      
      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        business_type: client ? client.businessType || user.business_type : user.business_type,
        clientId: user.clientId,
        token: generateToken(user._id),
        clientName: client ? client.name : null, // Add client name
        subscriptionPlan: client ? client.subscriptionPlan || 'v2' : 'v2',
        plan: client ? client.plan || 'CX Agent (V1)' : 'CX Agent (V1)',
        hasCompletedTour: user.hasCompletedTour,
        trialActive: client ? client.trialActive : null,
        trialEndsAt: client ? client.trialEndsAt : null,
        clientConfig: client ? {
          ...client.config,
          nicheData: client.nicheData || {},
          flowData: client.flowData || {},
          automationFlows: client.automationFlows || [],
          messageTemplates: client.messageTemplates || [],
          flowNodes: client.flowNodes || [],
          flowEdges: client.flowEdges || [],
          flowFolders: client.flowFolders || [],
          visualFlows: client.visualFlows || [],
          adminPhone: client.adminPhone || '',
          shopDomain: client.shopDomain || '',
          shopifyAccessToken: client.shopifyAccessToken || '',
          shopifyClientId: client.shopifyClientId || '',
          shopifyClientSecret: client.shopifyClientSecret || '',
          razorpayKeyId: client.razorpayKeyId || '',
          googleReviewUrl: client.googleReviewUrl || '',
          wabaId: client.wabaId || '',
          phoneNumberId: client.phoneNumberId || '',
          whatsappToken: client.whatsappToken || '',
          instagramConnected: client.instagramConnected || false
        } : {},
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

  try {
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    if (!businessName || !name || !email || !password || !otp) {
      return res.status(400).json({ message: 'All fields including OTP are required' });
    }

    // -- OTP Verification --
    const validOtp = await OTP.findOne({ email, otp, purpose: 'SIGNUP' });
    if (!validOtp) {
      return res.status(400).json({ message: 'Invalid or expired OTP.' });
    }
    // Delete OTP so it can't be reused
    await OTP.deleteOne({ _id: validOtp._id });

    // Generate unique clientId from business name + random hex
    const crypto = require('crypto');
    const safeName = businessName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const uniqueId = crypto.randomBytes(3).toString('hex');
    const newClientId = `${safeName}_${uniqueId}`;

    // Valid business types for client and user models
    const validTypes = ['ecommerce', 'salon', 'turf', 'clinic', 'choice_salon', 'choice_salon_new', 'agency', 'other'];
    const chosenType = (businessType && validTypes.includes(businessType)) ? businessType : 'other';

    // 1. Create the Client (Trial mode default)
    const newClient = await Client.create({
      clientId: newClientId,
      businessName: businessName,
      name: businessName,
      isActive: true,
      trialActive: true,
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      plan: 'CX Agent (V1)',
      businessType: chosenType, 
      flowNodes: [],
      flowEdges: []
    });

    // 2. Create the User linked to this new Client
    const user = await User.create({
      name,
      email,
      password,
      role: 'CLIENT_ADMIN',
      business_type: chosenType,
      clientId: newClientId
    });

    if (user && newClient) {
      res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        business_type: user.business_type,
        clientId: user.clientId,
        token: generateToken(user._id),
      });
    } else {
      res.status(400).json({ message: 'Failed to create user or client' });
    }
  } catch (error) {
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
  const { email, purpose } = req.body;
  if (!email) return res.status(400).json({ message: 'Email required' });

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

module.exports = router;
