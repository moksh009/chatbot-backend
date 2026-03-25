const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const log = require('../utils/logger')('AdminAPI');

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
router.get('/clients', protect, isSuperAdmin, async (req, res) => {
  try {
    log.info(`Fetching all clients — requested by user: ${req.user?._id}`);
    const clients = await Client.find().sort({ createdAt: -1 });
    log.info(`Returned ${clients.length} clients`);
    res.json(clients);
  } catch (err) {
    log.error('Error fetching clients', { error: err.message });
    res.status(500).json({ message: 'Server error fetching clients' });
  }
});

// --- GET CLIENT BY ID ---
router.get('/clients/:id', protect, isSuperAdmin, async (req, res) => {
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
router.post('/clients', protect, isSuperAdmin, async (req, res) => {
  try {
    const {
      clientId, name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData, wabaId, emailUser, emailAppPassword
    } = req.body;

    const existingClient = await Client.findOne({ clientId });
    if (existingClient) {
      log.warn(`Create client failed — clientId already exists: ${clientId}`);
      return res.status(400).json({ message: 'Client ID already exists' });
    }

    const newClient = new Client({
      clientId, name, businessType: businessType || 'other', niche: niche || 'other',
      plan: plan || 'CX Agent (V1)', isGenericBot: isGenericBot || false,
      phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId,
      openaiApiKey, nicheData: nicheData || {}, flowData: flowData || {},
      wabaId: wabaId || '', emailUser: emailUser || '', emailAppPassword: emailAppPassword || ''
    });

    const savedClient = await newClient.save();
    log.success(`New client provisioned: ${clientId} | Plan: ${plan || 'CX Agent (V1)'}`);
    res.status(201).json(savedClient);
  } catch (err) {
    log.error('Error creating client', { error: err.message });
    res.status(500).json({ message: 'Server error creating client', error: err.message });
  }
});

// --- UPDATE CLIENT ---
router.put('/clients/:id', protect, isSuperAdmin, async (req, res) => {
  try {
    log.info(`Updating client: ${req.params.id}`);
    const {
      name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData, wabaId, emailUser, emailAppPassword
    } = req.body;

    const updatedClient = await Client.findByIdAndUpdate(
      req.params.id,
      { $set: { name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData, wabaId, emailUser, emailAppPassword } },
      { new: true, runValidators: true }
    );

    if (!updatedClient) {
      log.warn(`Update client not found: ${req.params.id}`);
      return res.status(404).json({ message: 'Client not found' });
    }

    log.success(`Client updated: ${updatedClient.clientId}`);
    res.json(updatedClient);
  } catch (err) {
    log.error('Error updating client', { error: err.message });
    res.status(500).json({ message: 'Server error updating client', error: err.message });
  }
});

// --- DELETE CLIENT ---
router.delete('/clients/:id', protect, isSuperAdmin, async (req, res) => {
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
router.patch('/my-settings', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });

    const { nicheData, flowData } = req.body;

    const updated = await Client.findOneAndUpdate(
      { clientId: user.clientId },
      { $set: { nicheData, flowData } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Client not found' });

    log.success(`Client ${user.clientId} self-updated bot settings`);
    res.json({ success: true, nicheData: updated.nicheData, flowData: updated.flowData });
  } catch (err) {
    log.error('Self-service settings error', { clientId: req.user?.clientId, error: err.message });
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});
module.exports = router;
