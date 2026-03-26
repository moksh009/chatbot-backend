const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const log = require('../utils/logger')('AdminAPI');
const { getDefaultFlowForNiche } = require('../utils/defaultFlowNodes');

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

// --- RUN AUTOMATION MIGRATION (Super Admin) ---
// Temporarily public for easy browser execution (Add basic secret key param for safety)
router.get('/run-migration', async (req, res) => {
  try {
    const { key } = req.query;
    if (key !== 'topedge_secure_admin_123') {
      return res.status(401).json({ message: 'Unauthorized. Use ?key=topedge_secure_admin_123' });
    }

    const defaultAutomationFlows = [
      { id: 'abandoned_cart', isActive: true, config: { delayHours: 2 } },
      { id: 'cod_to_prepaid', isActive: false, config: { delayMinutes: 3, discountAmount: 50, gateway: 'razorpay' } },
      { id: 'review_collection', isActive: false, config: { delayDays: 4 } }
    ];

    const defaultMessageTemplates = [
      {
        id: "cod_to_prepaid",
        body: "Your order #{{order_number}} for *{{product_name}}* is confirmed via COD.\n\n💳 Pay via UPI now and save ₹{{discount_amount}}!\n\nOffer expires in 2 hours.",
        buttons: [{ label: "💳 Pay via UPI" }, { label: "Keep COD" }]
      },
      {
        id: "review_request",
        body: "Hi! How's your *{{product_name}}*? 😊\n\nYour feedback helps us improve and helps other customers!",
        buttons: [{ label: "😍 Loved it!" }, { label: "😐 It's okay" }, { label: "😕 Not happy" }]
      }
    ];

    const clients = await Client.find({});
    let updated = 0;

    for (const client of clients) {
        let isModified = false;

        // Seed default flow nodes if not already set
        if (!client.flowNodes || client.flowNodes.length === 0) {
          const niche = client.niche || client.businessType || 'other';
          const defaultFlow = getDefaultFlowForNiche(niche);
          client.flowNodes = defaultFlow.nodes;
          client.flowEdges = defaultFlow.edges;
          isModified = true;
        }

        if (!client.automationFlows || client.automationFlows.length === 0) {
            client.automationFlows = defaultAutomationFlows;
            isModified = true;
        } else {
             for (const defaultFlow of defaultAutomationFlows) {
                 if (!client.automationFlows.find(f => f.id === defaultFlow.id)) {
                     client.automationFlows.push(defaultFlow);
                     isModified = true;
                 }
             }
        }

        if (!client.messageTemplates || client.messageTemplates.length === 0) {
             client.messageTemplates = defaultMessageTemplates;
             isModified = true;
        } else {
             for (const defaultTemp of defaultMessageTemplates) {
                 if (!client.messageTemplates.find(f => f.id === defaultTemp.id)) {
                     client.messageTemplates.push(defaultTemp);
                     isModified = true;
                 }
             }
        }

        if (isModified) {
            const setFields = {};
            if (client.flowNodes) setFields.flowNodes = client.flowNodes;
            if (client.flowEdges) setFields.flowEdges = client.flowEdges;
            if (client.automationFlows) setFields.automationFlows = client.automationFlows;
            if (client.messageTemplates) setFields.messageTemplates = client.messageTemplates;

            await Client.updateOne(
              { _id: client._id },
              { $set: setFields },
              { runValidators: false }
            );
            updated++;
        }
    }

    res.json({ success: true, message: `Migration Complete: ${updated} clients were updated with the new Automation & Template features.` });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ error: error.message });
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

    const defaultFlow = getDefaultFlowForNiche(niche || businessType);
    const newClient = new Client({
      clientId, name, businessType: businessType || 'other', niche: niche || 'other',
      plan: plan || 'CX Agent (V1)', isGenericBot: isGenericBot || false,
      phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId,
      openaiApiKey, nicheData: nicheData || {}, flowData: flowData || {},
      automationFlows: automationFlows || [], messageTemplates: messageTemplates || [],
      wabaId: wabaId || '', emailUser: emailUser || '', emailAppPassword: emailAppPassword || '',
      flowNodes: defaultFlow.nodes,
      flowEdges: defaultFlow.edges,
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
    const { nicheData, flowData, automationFlows, messageTemplates, flowNodes, flowEdges, clientId } = req.body;
    
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
    if (flowNodes !== undefined) updateFields.flowNodes = flowNodes;
    if (flowEdges !== undefined) updateFields.flowEdges = flowEdges;

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
      niche: client.niche,
      nicheData: client.nicheData,
      flowData: client.flowData,
      automationFlows: client.automationFlows,
      messageTemplates: client.messageTemplates,
      flowNodes: client.flowNodes || [],
      flowEdges: client.flowEdges || [],
      plan: client.plan
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});
// --- RUN AUTOMATION MIGRATION (Super Admin) ---
router.get('/run-migration', protect, isSuperAdmin, async (req, res) => {
  try {
      const defaultAutomationFlows = [
        { id: 'abandoned_cart', isActive: true, config: { delayHours: 2 } },
        { id: 'cod_to_prepaid', isActive: false, config: { delayMinutes: 3, discountAmount: 50, gateway: 'razorpay' } },
        { id: 'review_collection', isActive: false, config: { delayDays: 4 } }
      ];

      const defaultMessageTemplates = [
        {
          id: "cod_to_prepaid",
          body: "Your order #{{order_number}} for *{{product_name}}* is confirmed via COD.\n\n💳 Pay via UPI now and save ₹{{discount_amount}}!\n\nOffer expires in 2 hours.",
          buttons: [{ label: "💳 Pay via UPI" }, { label: "Keep COD" }]
        },
        {
          id: "review_request",
          body: "Hi! How's your *{{product_name}}*? 😊\n\nYour feedback helps us improve and helps other customers!",
          buttons: [{ label: "😍 Loved it!" }, { label: "😐 It's okay" }, { label: "😕 Not happy" }]
        }
      ];

      const clients = await Client.find({});
      let updated = 0;

      for (const client of clients) {
          let isModified = false;

          if (!client.automationFlows || client.automationFlows.length === 0) {
              client.automationFlows = defaultAutomationFlows;
              isModified = true;
          } else {
               for (const defaultFlow of defaultAutomationFlows) {
                   if (!client.automationFlows.find(f => f.id === defaultFlow.id)) {
                       client.automationFlows.push(defaultFlow);
                       isModified = true;
                   }
               }
          }

          if (!client.messageTemplates || client.messageTemplates.length === 0) {
               client.messageTemplates = defaultMessageTemplates;
               isModified = true;
          } else {
               for (const defaultTemp of defaultMessageTemplates) {
                   if (!client.messageTemplates.find(f => f.id === defaultTemp.id)) {
                       client.messageTemplates.push(defaultTemp);
                       isModified = true;
                   }
               }
          }

          if (isModified) {
              await client.save();
              updated++;
          }
      }

      res.json({ message: `Migration Complete: ${updated} clients were updated with the new Automation & Template features.` });
  } catch (err) {
      log.error('Migration failed via API', { error: err.message });
      res.status(500).json({ message: 'Migration Failed', error: err.message });
  }
});

module.exports = router;
