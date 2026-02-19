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

    res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        business_type: user.business_type,
        clientId: user.clientId,
        clientName: client ? client.name : null, // Add client name
        subscriptionPlan: client ? client.subscriptionPlan || 'v2' : 'v2', // Add subscription plan
        clientConfig: client ? client.config : {},
        clientTemplates: client && client.config && client.config.templates ? client.config.templates : null
    });
  } catch (error) {
    console.error(error);
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
        business_type: user.business_type,
        clientId: user.clientId,
        token: generateToken(user._id),
        clientName: client ? client.name : null, // Add client name
        subscriptionPlan: client ? client.subscriptionPlan || 'v2' : 'v2',
        clientConfig: client ? client.config : {},
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
  const { name, email, password, role, clientId } = req.body;

  try {
    const userExists = await User.findOne({ email });

    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const user = await User.create({
      name,
      email,
      password,
      role: role || 'CLIENT_ADMIN',
      business_type: req.body.business_type || 'clinic',
      clientId: clientId || 'delitech_smarthomes' // Updated default for Delitech project
    });

    if (user) {
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
      res.status(400).json({ message: 'Invalid user data' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

router.get('/ping', async (_req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

module.exports = router;
