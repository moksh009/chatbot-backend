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
      clientId, name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData, wabaId, emailUser, emailAppPassword, automationFlows, messageTemplates
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
      automationFlows: automationFlows || [], messageTemplates: messageTemplates || [],
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
      name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData, automationFlows, messageTemplates, wabaId, emailUser, emailAppPassword
    } = req.body;

    const updatedClient = await Client.findByIdAndUpdate(
      req.params.id,
      { $set: { name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData, automationFlows, messageTemplates, wabaId, emailUser, emailAppPassword } },
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
    const { nicheData, flowData, automationFlows, messageTemplates, clientId } = req.body;
    
    // If Super Admin and clientId provided, use that. Otherwise use user's own.
    let targetClientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && clientId) {
      targetClientId = clientId;
    }

    if (!targetClientId) {
      return res.status(400).json({ message: 'No target clientId specified' });
    }

    const updateFields = {};
    if (nicheData !== undefined) updateFields.nicheData = nicheData;
    if (flowData !== undefined) updateFields.flowData = flowData;
    if (automationFlows !== undefined) updateFields.automationFlows = automationFlows;
    if (messageTemplates !== undefined) updateFields.messageTemplates = messageTemplates;

    const updated = await Client.findOneAndUpdate(
      { clientId: targetClientId },
      { $set: updateFields },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Client not found' });

    log.success(`${req.user.role} updated settings for: ${targetClientId}`);
    res.json({ 
      success: true, 
      nicheData: updated.nicheData, 
      flowData: updated.flowData,
      automationFlows: updated.automationFlows,
      messageTemplates: updated.messageTemplates
    });
  } catch (err) {
    log.error('Settings update error', { error: err.message });
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// --- GET SETTINGS BY CLIENTID (Super Admin) ---
router.get('/settings/:clientId', protect, isSuperAdmin, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });
    
    res.json({
      clientId: client.clientId,
      businessType: client.businessType,
      nicheData: client.nicheData,
      flowData: client.flowData,
      automationFlows: client.automationFlows,
      messageTemplates: client.messageTemplates,
      plan: client.plan
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});
module.exports = router;
