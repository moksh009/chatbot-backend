const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const log = require('../utils/logger')('AdminAPI');
const { getDefaultFlowForNiche } = require('../utils/defaultFlowNodes');
const { generateFlowForClient } = require('../utils/flowAutogen');
const { convertLegacyToVisual } = require('../utils/legacyConverter');
const { runFullMigration } = require('../scripts/phase9MigrationLogic');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const CLIENT_CODE_DIR = path.join(__dirname, 'clientcodes');

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

// --- SECURE MIGRATION (PROTECTED) ---
router.get('/run-secure-migration', protect, isSuperAdmin, async (req, res) => {
    try {
        const result = await runFullMigration();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: 'Migration failed: ' + err.message });
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
      clientId, name, businessType, niche, plan, isGenericBot, systemPrompt,
      phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken,
      googleCalendarId, openaiApiKey, nicheData, flowData,
      wabaId, emailUser, emailAppPassword, automationFlows, messageTemplates,
      razorpayKeyId, razorpaySecret, adminPhone,
      shopDomain, shopifyAccessToken, shopifyWebhookSecret, googleReviewUrl
    } = req.body;

    const existingClient = await Client.findOne({ clientId });
    if (existingClient) {
      log.warn(`Create client failed — clientId already exists: ${clientId}`);
      return res.status(400).json({ message: 'Client ID already exists' });
    }

    const newClient = new Client({
      clientId, name, businessType: businessType || 'other', niche: niche || 'other',
      plan: plan || 'CX Agent (V1)', isGenericBot: isGenericBot || false,
      systemPrompt: systemPrompt || '',
      phoneNumberId, whatsappToken, verifyToken: webhookVerifyToken, googleCalendarId,
      openaiApiKey, nicheData: nicheData || {}, flowData: flowData || {},
      automationFlows: (automationFlows && automationFlows.length > 0) ? automationFlows : defaultAutomationFlows,
      messageTemplates: (messageTemplates && messageTemplates.length > 0) ? messageTemplates : defaultMessageTemplates,
      wabaId: wabaId || '', emailUser: emailUser || '', emailAppPassword: emailAppPassword || '',
      razorpayKeyId: razorpayKeyId || '', razorpaySecret: razorpaySecret || '',
      adminPhone: adminPhone || '', shopDomain: shopDomain || '',
      shopifyAccessToken: shopifyAccessToken || '', shopifyWebhookSecret: shopifyWebhookSecret || '',
      googleReviewUrl: googleReviewUrl || '',
      flowNodes: [], flowEdges: [],
    });

    // --- PHASE 10: Automatic Flow Generation during Onboarding ---
    const aiFlow = await generateFlowForClient(newClient, systemPrompt);
    if (aiFlow) {
      newClient.flowNodes = aiFlow.nodes;
      newClient.flowEdges = aiFlow.edges;
    } else {
      const defaultFlow = getDefaultFlowForNiche(niche || businessType);
      newClient.flowNodes = defaultFlow.nodes;
      newClient.flowEdges = defaultFlow.edges;
    }

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
      name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken,
      verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData,
      automationFlows, messageTemplates, wabaId, emailUser, emailAppPassword,
      razorpayKeyId, razorpaySecret, adminPhone,
      shopDomain, shopifyAccessToken, shopifyWebhookSecret, googleReviewUrl
    } = req.body;

    const updatedClient = await Client.findByIdAndUpdate(
      req.params.id,
      { $set: {
        name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken,
        verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData,
        automationFlows, messageTemplates, wabaId, emailUser, emailAppPassword,
        razorpayKeyId, razorpaySecret, adminPhone,
        shopDomain, shopifyAccessToken, shopifyWebhookSecret, googleReviewUrl
      }},
      { new: true, runValidators: false }
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
    const { nicheData, flowData, automationFlows, messageTemplates, flowNodes, flowEdges, simpleSettings, clientId } = req.body;
    
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
    if (simpleSettings !== undefined) updateFields.simpleSettings = simpleSettings;

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
router.get('/run-automation-migration', protect, isSuperAdmin, async (req, res) => {
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
              const setFields = {};
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

      res.json({ message: `Migration Complete: ${updated} clients were updated with the new Automation & Template features.` });
  } catch (err) {
      log.error('Migration failed via API', { error: err.message });
      res.status(500).json({ message: 'Migration Failed', error: err.message });
  }
});

// --- AI FLOW GENERATION (Gemini) ---
router.post('/generate-flow', protect, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });

    const genAI = new GoogleGenerativeAI(apiKey);
    let model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const systemPrompt = `You are a WhatsApp chatbot flow designer. Given a business description, generate a JSON object with "nodes" and "edges" arrays for a ReactFlow diagram.
    
    The flow must ALWAYS start with a "trigger" node (id: "node_0").
    Connect nodes logically. For interactive buttons/lists, use source handles that match the item ID (e.g. "opt_1", "opt_2").
    
    Node Types and Schema:
    1. "trigger": { keyword: "hi" } (Starts the flow)
    2. "message": { text: "Hello!", imageUrl?: "https://...", footer?: "Optional" }
    3. "interactive": { 
         interactiveType: "button" (max 3) or "list" (max 10),
         header?: "Welcome", 
         text: "Choose an option", 
         buttonsList: [{id: "opt_1", title: "Option 1"}],
         imageUrl?: "...", 
         footer?: "..." 
       }
    4. "image": { imageUrl: "...", caption?: "..." }
    5. "template": { templateName: "...", languageCode: "en", buttons: [{id, title}] }
    
    Visual Layout:
    Position nodes logically with enough spacing (dx=350, dy=250).
    
    Business description: ${prompt}
    
    Return ONLY valid JSON. No markdown. Start with { and end with }.
    
    Business description: ${prompt}`;

    console.log('[generate-flow] Calling Gemini API...');
    let result;
    try {
      result = await model.generateContent(systemPrompt);
    } catch (apiErr) {
      console.error('[generate-flow] Flash failed, falling back to Pro:', apiErr.message);
      const proModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
      result = await proModel.generateContent(systemPrompt);
    }

    const rawText = result.response.text().trim();
    console.log('[generate-flow] Gemini raw response (first 500 chars):', rawText.slice(0, 500));

    // Strip markdown code fences if Gemini wraps JSON in ```json ... ```
    let cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // Extract the outermost JSON object
    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      cleaned = cleaned.substring(startIdx, endIdx + 1);
    }
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[generate-flow] No JSON found in response:', rawText.slice(0, 300));
      return res.status(500).json({ error: 'AI did not return valid JSON', raw: rawText.slice(0, 300) });
    }

    let flow;
    try {
      flow = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[generate-flow] JSON parse error:', parseErr.message, '| raw:', jsonMatch[0].slice(0, 300));
      return res.status(500).json({ error: 'Failed to parse AI JSON: ' + parseErr.message, raw: jsonMatch[0].slice(0, 200) });
    }

    if (!flow.nodes || !flow.edges) {
      return res.status(500).json({ error: 'AI response missing nodes or edges', flow });
    }

    console.log('[generate-flow] Success — nodes:', flow.nodes.length, '| edges:', flow.edges.length);
    res.json({ success: true, nodes: flow.nodes, edges: flow.edges });
  } catch (err) {
    console.error('[generate-flow] FATAL:', err.message, err.stack?.slice(0, 500));
    res.status(500).json({ 
      error: 'AI Generation Failed: ' + err.message,
      suggestion: 'Check your GEMINI_API_KEY or try again.' 
    });
  }
});

// --- GEMINI KEY PROBE (no auth — for diagnostics) ---
router.get('/test-gemini', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY not set' });
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    let model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    let result;
    try {
        result = await model.generateContent('Say "ok" in JSON like {"status":"ok"}');
    } catch (apiErr) {
        console.warn('[test-gemini] Flash failed, testing Pro:', apiErr.message);
        model = genAI.getGenerativeModel({ model: 'gemini-pro' });
        result = await model.generateContent('Say "ok" in JSON like {"status":"ok"}');
    }
    const text = result.response.text().trim();
    res.json({ ok: true, raw: text.slice(0, 200) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- MANUAL SEEDING ROUTE (Admin Only) ---
router.post('/seed-niche-data', protect, async (req, res) => {
    try {
        const clients = await Client.find({});
        let updated = 0;
        const DEFAULT_ECOMMERCE = {
            welcomeMessage: "Hi! 👋 Welcome to our store. We're here to help you find the best products. How can we assist you today?",
            bannerImage: "https://images.unsplash.com/photo-1558002038-1055907df827?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Shop Now 🛍️",
            supportReply: "Our AI assistant is ready! You can check product availability, track orders, or talk to our team.",
            orderConfirmMsg: "Hi {name}, your order for {items} worth ₹{total} is confirmed! Payment: {payment}. We'll ship soon! 📦",
            abandonedMsg1: "Hi {name}! 👋 You left some items in your cart. Would you like to complete your order?",
            abandonedMsg2: "Last chance, {name}! 🎁 Your cart is still waiting. Complete your purchase now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review"
        };
        const DEFAULT_SALON = {
            welcomeMessage: "Hey! 💇‍♀️ Welcome to our Salon. Treat yourself to our premium services. How can we pamper you today?",
            bannerImage: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Book Appointment 📅",
            supportReply: "We provide professional hair and beauty services. Our team is expert in advanced treatments and cuts.",
            orderConfirmMsg: "Hi {name}, your booking for {items} on {date} at {time} is confirmed! See you soon! ✨",
            abandonedMsg1: "Hi {name}! 👋 We saw you looking at our services. Would you like to book a slot?",
            abandonedMsg2: "Still thinking about that makeover, {name}? 💅 Book now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review",
            calendars: { "Main Stylist": "" },
            services: [{ name: "Haircut", price: "500", duration: "30" }]
        };

        for (const client of clients) {
            if (!client.nicheData || Object.keys(client.nicheData).length === 0) {
                client.nicheData = (client.businessType === 'ecommerce') ? DEFAULT_ECOMMERCE : DEFAULT_SALON;
                await client.save();
                updated++;
            }
        }
        res.json({ success: true, message: `${updated} clients seeded with default data.` });
    } catch (err) {
        res.status(500).json({ error: 'Seeding failed: ' + err.message });
    }
});

// --- BROWSER-BASED SEEDING (GET) ---
// Paste this in browser: [BACKEND_URL]/api/admin/seed-now
router.get('/seed-now', protect, async (req, res) => {
    try {
        const clients = await Client.find({});
        let updated = 0;
        const DEFAULT_ECOMMERCE = {
            welcomeMessage: "Hi! 👋 Welcome to our store. We're here to help you find the best products. How can we assist you today?",
            bannerImage: "https://images.unsplash.com/photo-1558002038-1055907df827?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Shop Now 🛍️",
            supportReply: "Our AI assistant is ready! You can check product availability, track orders, or talk to our team.",
            orderConfirmMsg: "Hi {name}, your order for {items} worth ₹{total} is confirmed! Payment: {payment}. We'll ship soon! 📦",
            abandonedMsg1: "Hi {name}! 👋 You left some items in your cart. Would you like to complete your order?",
            abandonedMsg2: "Last chance, {name}! 🎁 Your cart is still waiting. Complete your purchase now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review"
        };
        const DEFAULT_SALON = {
            welcomeMessage: "Hey! 💇‍♀️ Welcome to our Salon. Treat yourself to our premium services. How can we pamper you today?",
            bannerImage: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Book Appointment 📅",
            supportReply: "We provide professional hair and beauty services. Our team is expert in advanced treatments and cuts.",
            orderConfirmMsg: "Hi {name}, your booking for {items} on {date} at {time} is confirmed! See you soon! ✨",
            abandonedMsg1: "Hi {name}! 👋 We saw you looking at our services. Would you like to book a slot?",
            abandonedMsg2: "Still thinking about that makeover, {name}? 💅 Book now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review",
            calendars: { "Main Stylist": "" },
            services: [{ name: "Haircut", price: "500", duration: "30" }]
        };

        for (const client of clients) {
            if (!client.nicheData || Object.keys(client.nicheData).length === 0) {
                client.nicheData = (client.businessType === 'ecommerce' || client.clientId.includes('smarthomes')) ? DEFAULT_ECOMMERCE : DEFAULT_SALON;
                await client.save();
                updated++;
            }
        }
        res.send(`<h1>Seeding Complete</h1><p>${updated} clients were updated with default niche data.</p><a href="/admin/settings">Back to Dashboard</a>`);
    } catch (err) {
        res.status(500).send(`<h1>Seeding Failed</h1><p>${err.message}</p>`);
    }
});

// --- PHASE 9: META TEMPLATE SYNC ---
router.get('/templates/sync/:clientId', async (req, res) => {
    try {
        let { clientId } = req.params;
        const { key } = req.query;

        // Robustness: strip leading colon if user copy-pasted literally
        if (clientId.startsWith(':')) clientId = clientId.substring(1);

        // Allow bypass with secure key or regular auth
        const isSecureKey = key === 'topedge_secure_admin_123';
        if (!isSecureKey && !req.user) {
            // If not secure key and not logged in (protect middleware would have run if we used it)
            // But since we want browser access, we'll manually check for key first.
            return res.status(401).json({ message: "Not authorized. Provide key or login." });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });
        
        if (!client.wabaId || !client.whatsappToken) {
            return res.status(400).json({ error: 'WABA ID or WhatsApp Token missing.' });
        }

        log.info(`Syncing templates for ${clientId} via Meta API...`);
        const url = `https://graph.facebook.com/v18.0/${client.wabaId}/message_templates?limit=100`;
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${client.whatsappToken}` } });
        
        const approvedTemplates = response.data.data.filter(t => t.status === 'APPROVED');
        client.syncedMetaTemplates = approvedTemplates;
        await client.save();
        
        res.json({ success: true, count: approvedTemplates.length, templates: approvedTemplates });
    } catch (err) {
        log.error('Template Sync Failed', { error: err.message });
        res.status(500).json({ error: 'Sync Failed: ' + (err.response?.data?.error?.message || err.message) });
    }
});

// --- SYNC META FLOWS ---
router.get('/flows/sync/:clientId', protect, async (req, res) => {
    try {
        let { clientId } = req.params;
        if (clientId.startsWith(':')) clientId = clientId.substring(1);
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        if (!client.wabaId || !client.whatsappToken) {
            return res.status(400).json({ error: 'WABA ID or WhatsApp Token missing.' });
        }

        log.info(`Syncing flows for ${clientId}...`);
        const url = `https://graph.facebook.com/v18.0/${client.wabaId}/flows?limit=100`;
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${client.whatsappToken}` } });
        
        const flows = response.data.data || [];
        client.syncedMetaFlows = flows;
        await client.save();
        
        res.json({ success: true, count: flows.length, flows });
    } catch (err) {
        log.error('Flow Sync Failed', { error: err.message });
        res.status(500).json({ error: 'Sync Failed: ' + (err.response?.data?.error?.message || err.message) });
    }
});

// --- SYSTEM MIGRATION (BROWSER-READY) ---
router.get('/run-full-migration', async (req, res) => {
    const { key } = req.query;
    if (key !== 'topedge_secure_admin_123') {
        return res.status(401).send('<h1>Access Denied</h1><p>Invalid migration key.</p>');
    }

    try {
        const clients = await Client.find({});
        let updated = 0;
        
        // Define missing defaults
        const defaultAutomationFlows = [
            { id: 'abandoned_cart', isActive: false },
            { id: 'cod_to_prepaid', isActive: false },
            { id: 'review_collection', isActive: false }
        ];

        for (const client of clients) {
            let isModified = false;
            
            // 1. Ensure automationFlows exists
            if (!client.automationFlows || client.automationFlows.length === 0) {
                client.automationFlows = defaultAutomationFlows;
                isModified = true;
            }

            // 2. Ensure simpleSettings exists
            if (!client.simpleSettings) {
                client.simpleSettings = { keywordFallbacks: [], variableMap: {}, welcomeStartNodeId: 'node_1' };
                isModified = true;
            }

            if (isModified) {
                await client.save();
                updated++;
            }
        }
        
        res.send(`<h1>Migration Successful</h1><p>Processed ${clients.length} clients. Updated ${updated} clients with new features.</p>`);
    } catch (err) {
        log.error('Migration failed', err.message);
        res.status(500).send(`<h1>Migration Error</h1><p>${err.message}</p>`);
    }
});


// --- PHASE 9/10: AI FLOW AUTO-GENERATION ---
router.post('/flow/autogen/:clientId', protect, async (req, res) => {
    try {
        const { prompt, flowNodes, flowEdges } = req.body;
        const client = await Client.findOne({ clientId: req.params.clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const existingFlow = (flowNodes && flowNodes.length > 0) ? { nodes: flowNodes, edges: flowEdges } : null;
        const aiFlow = await generateFlowForClient(client, prompt, existingFlow);
        if (!aiFlow) return res.status(500).json({ error: 'Failed to generate flow with AI. Please try again or provide more details.' });

        client.flowNodes = aiFlow.nodes;
        client.flowEdges = aiFlow.edges;
        if (prompt) client.systemPrompt = prompt;

        await client.save();
        res.json({ success: true, nodes: aiFlow.nodes, edges: aiFlow.edges });
    } catch (err) {
        log.error('Manual Auto-gen failed', { error: err.message });
        res.status(500).json({ error: 'Failed to generate flow: ' + err.message });
    }
});

// --- CONVERT LEGACY JS FLOW TO VISUAL FLOW (AI) ---
router.post('/flow/convert-legacy/:clientId', async (req, res) => {
    try {
        let { clientId } = req.params;
        if (clientId.startsWith(':')) clientId = clientId.substring(1);
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Map clientId to legacy file
        let fileName = '';
        if (clientId === 'delitech_smarthomes' || clientId === 'ved') fileName = 'delitech_smarthomes.js';
        else if (clientId === 'choice_salon_holi' || clientId === 'choice_salon') fileName = 'choice_salon_holi.js';
        else if (clientId === 'turf') fileName = 'turf.js';
        else {
             // Try common patterns if not found
             fileName = `${clientId}.js`;
        }

        const filePath = path.join(CLIENT_CODE_DIR, fileName);
        if (!fs.existsSync(filePath)) {
            return res.status(400).json({ error: `Legacy file not found: ${fileName}` });
        }

        const fileCode = fs.readFileSync(filePath, 'utf8');
        log.info(`Converting legacy flow for ${clientId}...`);

        const flowJson = await convertLegacyToVisual(clientId, fileCode);
        
        client.flowNodes = flowJson.nodes || [];
        client.flowEdges = flowJson.edges || [];
        client.isGenericBot = true; // Switch to generic hub engine after conversion
        await client.save();

        res.json({ success: true, message: `Migrated ${flowJson.nodes.length} nodes from legacy file.` });
    } catch (err) {
        log.error('Conversion Error', err.message);
        res.status(500).json({ error: 'Conversion failed: ' + err.message });
    }
});

module.exports = router;
