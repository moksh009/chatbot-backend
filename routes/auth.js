const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

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
  const { name, email, password, businessName } = req.body;

  try {
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    if (!businessName || !name || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Generate unique clientId from business name + random hex
    const crypto = require('crypto');
    const safeName = businessName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const uniqueId = crypto.randomBytes(3).toString('hex');
    const newClientId = `${safeName}_${uniqueId}`;

    // 1. Create the Client (Trial mode default)
    const newClient = await Client.create({
      clientId: newClientId,
      businessName: businessName,
      name: businessName,
      isActive: true,
      trialActive: true,
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      plan: 'CX Agent (V1)',
      businessType: 'ecommerce', // default
      flowNodes: [],
      flowEdges: []
    });

    // 2. Create the User linked to this new Client
    const user = await User.create({
      name,
      email,
      password,
      role: 'CLIENT_ADMIN',
      business_type: 'ecommerce',
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

module.exports = router;
