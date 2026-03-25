const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const User = require('../models/User');
const { verifyToken } = require('../middleware/auth');

// Middleware to check if user is a Super Admin
const isSuperAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (user && user.role === 'SUPER_ADMIN') {
      next();
    } else {
      res.status(403).json({ message: 'Access denied: Super Admin only' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

// --- GET ALL CLIENTS ---
router.get('/clients', verifyToken, isSuperAdmin, async (req, res) => {
  try {
    const clients = await Client.find().sort({ createdAt: -1 });
    res.json(clients);
  } catch (err) {
    console.error('Error fetching clients:', err);
    res.status(500).json({ message: 'Server error fetching clients' });
  }
});

// --- GET CLIENT BY ID ---
router.get('/clients/:id', verifyToken, isSuperAdmin, async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }
    res.json(client);
  } catch (err) {
    console.error('Error fetching client details:', err);
    res.status(500).json({ message: 'Server error fetching client details' });
  }
});

// --- CREATE NEW CLIENT ---
router.post('/clients', verifyToken, isSuperAdmin, async (req, res) => {
  try {
    const { 
      clientId, name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData, wabaId, emailUser, emailAppPassword
    } = req.body;

    const existingClient = await Client.findOne({ clientId });
    if (existingClient) {
      return res.status(400).json({ message: 'Client ID already exists' });
    }

    const newClient = new Client({
      clientId,
      name,
      businessType: businessType || 'other',
      niche: niche || 'other',
      plan: plan || 'CX Agent (V1)',
      isGenericBot: isGenericBot || false,
      phoneNumberId,
      whatsappToken,
      verifyToken: webhookVerifyToken,
      googleCalendarId,
      openaiApiKey,
      nicheData: nicheData || {},
      flowData: flowData || {},
      wabaId: wabaId || '',
      emailUser: emailUser || '',
      emailAppPassword: emailAppPassword || ''
    });

    const savedClient = await newClient.save();
    res.status(201).json(savedClient);
  } catch (err) {
    console.error('Error creating client:', err);
    res.status(500).json({ message: 'Server error creating client', error: err.message });
  }
});

// --- UPDATE CLIENT ---
router.put('/clients/:id', verifyToken, isSuperAdmin, async (req, res) => {
  try {
    const { 
      name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData, wabaId, emailUser, emailAppPassword
    } = req.body;

    const updatedClient = await Client.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
           name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData, wabaId, emailUser, emailAppPassword
        }
      },
      { new: true, runValidators: true }
    );

    if (!updatedClient) {
      return res.status(404).json({ message: 'Client not found' });
    }

    res.json(updatedClient);
  } catch (err) {
    console.error('Error updating client:', err);
    res.status(500).json({ message: 'Server error updating client', error: err.message });
  }
});

// --- DELETE CLIENT ---
router.delete('/clients/:id', verifyToken, isSuperAdmin, async (req, res) => {
  try {
    const deletedClient = await Client.findByIdAndDelete(req.params.id);
    if (!deletedClient) {
      return res.status(404).json({ message: 'Client not found' });
    }
    res.json({ message: 'Client deleted successfully' });
  } catch (err) {
    console.error('Error deleting client:', err);
    res.status(500).json({ message: 'Server error deleting client' });
  }
});

// --- CLIENT SELF-SERVICE: Update own nicheData/flowData ---
// Any authenticated user can update their OWN client's editable fields
router.patch('/my-settings', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });

    const { nicheData, flowData } = req.body;

    // Clients can only update nicheData and flowData, not credentials
    const updated = await Client.findOneAndUpdate(
      { clientId: user.clientId },
      { $set: { nicheData, flowData } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Client not found' });

    console.log(`[Admin API] Client ${user.clientId} self-updated their bot settings.`);
    res.json({ success: true, nicheData: updated.nicheData, flowData: updated.flowData });
  } catch (err) {
    console.error('[Admin API] Self-service settings error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
